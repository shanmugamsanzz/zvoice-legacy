import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { measureExternalProvider } from '../performance/performance-context.js';
import {
  DeleteObjectCommand, GetObjectCommand, ListObjectVersionsCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';

let storageClient;
let nativeB2Preferred = false;

async function authorizeNativeB2() {
  const basicToken = Buffer.from(`${env.B2_KEY_ID}:${env.B2_APPLICATION_KEY}`).toString('base64');
  const authorization = await fetchB2Json('https://api.backblazeb2.com/b2api/v4/b2_authorize_account', {
    headers: { authorization: `Basic ${basicToken}` },
  }, 'authorize-native-fallback');
  const storageApi = authorization.apiInfo?.storageApi;
  if (!storageApi?.apiUrl || !storageApi?.downloadUrl || !authorization.authorizationToken) {
    throw new Error('Backblaze B2 native authorization response was incomplete');
  }
  return { ...storageApi, authorizationToken: authorization.authorizationToken };
}

async function nativeB2Json(url, authorizationToken, body, operation) {
  return fetchB2Json(url, {
    method: 'POST',
    headers: { authorization: authorizationToken, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, operation);
}

async function nativeFileVersions(prefix) {
  const authorization = await authorizeNativeB2();
  const files = [];
  let startFileName;
  let startFileId;
  do {
    const page = await nativeB2Json(
      `${authorization.apiUrl}/b2api/v4/b2_list_file_versions`,
      authorization.authorizationToken,
      {
        bucketId: env.B2_BUCKET_ID,
        prefix,
        maxFileCount: 1000,
        ...(startFileName ? { startFileName } : {}),
        ...(startFileId ? { startFileId } : {}),
      },
      'list-file-versions-native-fallback',
    );
    files.push(...(page.files ?? []));
    startFileName = page.nextFileName;
    startFileId = page.nextFileId;
  } while (startFileName);
  return { authorization, files };
}

async function nativeFileInfo(key, versionId) {
  if (versionId) {
    const authorization = await authorizeNativeB2();
    const info = await nativeB2Json(
      `${authorization.apiUrl}/b2api/v4/b2_get_file_info`,
      authorization.authorizationToken,
      { fileId: versionId },
      'get-file-info-native-fallback',
    );
    return { authorization, info };
  }
  const result = await nativeFileVersions(key);
  const info = result.files.find((entry) => entry.fileName === key && entry.action === 'upload');
  if (!info) throw new Error(`Backblaze B2 object was not found: ${key}`);
  return { authorization: result.authorization, info };
}

async function nativeGetB2Object({ key, versionId, maxBytes }) {
  const { authorization, info } = await nativeFileInfo(key, versionId);
  const size = Number(info.contentLength);
  if (maxBytes && Number.isFinite(size) && size > maxBytes) {
    throw new Error(`Backblaze B2 object exceeds the ${maxBytes}-byte download limit`);
  }
  return measureExternalProvider('backblaze-b2', 'get-object-native-fallback', async () => {
    const url = new URL(`${authorization.downloadUrl}/b2api/v4/b2_download_file_by_id`);
    url.searchParams.set('fileId', info.fileId);
    const response = await fetch(url, {
      headers: { authorization: authorization.authorizationToken },
      signal: AbortSignal.timeout(env.PROVIDER_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Backblaze B2 native download failed with HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (maxBytes && bytes.length > maxBytes) {
      throw new Error(`Backblaze B2 object exceeds the ${maxBytes}-byte download limit`);
    }
    return {
      bucket: env.B2_BUCKET,
      key: info.fileName,
      versionId: info.fileId,
      contentType: info.contentType ?? response.headers.get('content-type'),
      metadata: info.fileInfo ?? {},
      body: bytes,
    };
  });
}

async function nativeDeleteVersion(key, versionId, authorization = undefined) {
  const auth = authorization ?? await authorizeNativeB2();
  await nativeB2Json(
    `${auth.apiUrl}/b2api/v4/b2_delete_file_version`,
    auth.authorizationToken,
    { fileName: key, fileId: versionId },
    'delete-file-version-native-fallback',
  );
}

async function nativeDeleteAllVersions(key) {
  const { authorization, files } = await nativeFileVersions(key);
  const entries = files.filter((entry) => entry.fileId && entry.fileName === key);
  for (const entry of entries) {
    await nativeDeleteVersion(entry.fileName, entry.fileId, authorization);
  }
  return {
    bucket: env.B2_BUCKET,
    key,
    deletedCount: entries.length,
    deleted: true,
  };
}

async function nativePutB2Object({ key, body, contentType, metadata }) {
  const authorization = await authorizeNativeB2();
  const target = await fetchB2Json(`${authorization.apiUrl}/b2api/v4/b2_get_upload_url`, {
    method: 'POST',
    headers: {
      authorization: authorization.authorizationToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ bucketId: env.B2_BUCKET_ID }),
  }, 'get-upload-url-native-fallback');

  return measureExternalProvider('backblaze-b2', 'put-object-native-fallback', async () => {
    const headers = {
      authorization: target.authorizationToken,
      'content-type': contentType,
      'content-length': String(body.length),
      'x-bz-file-name': encodeURIComponent(key),
      'x-bz-content-sha1': crypto.createHash('sha1').update(body).digest('hex'),
    };
    for (const [name, value] of Object.entries(metadata ?? {})) {
      const safeName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50);
      if (safeName) headers[`x-bz-info-${safeName}`] = encodeURIComponent(String(value));
    }
    const response = await fetch(target.uploadUrl, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(env.PROVIDER_REQUEST_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`Backblaze B2 native upload failed with HTTP ${response.status} (${payload?.code ?? 'B2_UPLOAD_FAILED'})`);
    }
    return {
      bucket: env.B2_BUCKET,
      key: payload.fileName ?? key,
      etag: payload.contentSha1 ?? null,
      storageVersionId: payload.fileId ?? null,
    };
  });
}

function requiredStorageConfig() {
  const missing = [
    ['B2_S3_ENDPOINT', env.B2_S3_ENDPOINT],
    ['B2_REGION', env.B2_REGION],
    ['B2_BUCKET', env.B2_BUCKET],
    ['B2_KEY_ID', env.B2_KEY_ID],
    ['B2_APPLICATION_KEY', env.B2_APPLICATION_KEY],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`Backblaze B2 storage requires ${missing.join(', ')}`);
}

function getStorageClient() {
  requiredStorageConfig();
  storageClient ??= new S3Client({
    endpoint: env.B2_S3_ENDPOINT,
    region: env.B2_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.B2_KEY_ID,
      secretAccessKey: env.B2_APPLICATION_KEY,
    },
    maxAttempts: 3,
  });
  return storageClient;
}

async function fetchB2Json(url, options, operation) {
  return measureExternalProvider('backblaze-b2', operation, async () => {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(env.PROVIDER_REQUEST_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`Backblaze B2 request failed with HTTP ${response.status} (${payload?.code ?? 'B2_REQUEST_FAILED'})`);
    }
    return payload;
  });
}

export async function checkB2() {
  const startedAt = performance.now();
  const basicToken = Buffer.from(`${env.B2_KEY_ID}:${env.B2_APPLICATION_KEY}`).toString('base64');
  const authorization = await fetchB2Json('https://api.backblazeb2.com/b2api/v4/b2_authorize_account', {
    headers: { authorization: `Basic ${basicToken}` },
  }, 'authorize');
  const storageApi = authorization.apiInfo?.storageApi;
  if (!storageApi?.apiUrl || !authorization.authorizationToken || !authorization.accountId) {
    throw new Error('Backblaze B2 authorization response was incomplete');
  }

  const buckets = await fetchB2Json(`${storageApi.apiUrl}/b2api/v4/b2_list_buckets`, {
    method: 'POST',
    headers: {
      authorization: authorization.authorizationToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ accountId: authorization.accountId, bucketId: env.B2_BUCKET_ID }),
  }, 'list-bucket');
  const bucket = buckets.buckets?.find((entry) => entry.bucketId === env.B2_BUCKET_ID);
  if (!bucket || bucket.bucketName !== env.B2_BUCKET) {
    throw new Error('Configured Backblaze B2 bucket is not accessible');
  }

  return { ok: true, latencyMs: Math.round((performance.now() - startedAt) * 100) / 100 };
}

export async function putB2Object({ key, body, contentType, metadata = {} }) {
  if (!Buffer.isBuffer(body)) throw new TypeError('Backblaze B2 upload body must be a Buffer');
  if (nativeB2Preferred) return nativePutB2Object({ key, body, contentType, metadata });
  try {
    return await measureExternalProvider('backblaze-b2', 'put-object', async () => {
      const result = await getStorageClient().send(new PutObjectCommand({
        Bucket: env.B2_BUCKET,
        Key: key,
        Body: body,
        ContentLength: body.length,
        ContentType: contentType,
        Metadata: Object.fromEntries(Object.entries(metadata).map(([name, value]) => [name, String(value)])),
      }), { abortSignal: AbortSignal.timeout(env.PROVIDER_REQUEST_TIMEOUT_MS) });
      return {
        bucket: env.B2_BUCKET,
        key,
        etag: result.ETag?.replaceAll('"', '') ?? null,
        storageVersionId: result.VersionId ?? null,
      };
    });
  } catch (s3Error) {
    try {
      nativeB2Preferred = true;
      return await nativePutB2Object({ key, body, contentType, metadata });
    } catch (nativeError) {
      throw new AggregateError([s3Error, nativeError], 'Backblaze B2 upload failed through S3 and native APIs');
    }
  }
}

export async function getB2Object({ key, versionId = undefined, maxBytes = undefined }) {
  if (nativeB2Preferred) return nativeGetB2Object({ key, versionId, maxBytes });
  try {
    return await measureExternalProvider('backblaze-b2', 'get-object', async () => {
      const result = await getStorageClient().send(
        new GetObjectCommand({ Bucket: env.B2_BUCKET, Key: key, VersionId: versionId }),
        { abortSignal: AbortSignal.timeout(env.PROVIDER_REQUEST_TIMEOUT_MS) },
      );
      if (!result.Body) throw new Error('Backblaze B2 returned an empty object body');
      if (maxBytes && Number(result.ContentLength ?? 0) > maxBytes) {
        throw new Error(`Backblaze B2 object exceeds the ${maxBytes}-byte download limit`);
      }
      const bytes = await result.Body.transformToByteArray();
      if (maxBytes && bytes.length > maxBytes) {
        throw new Error(`Backblaze B2 object exceeds the ${maxBytes}-byte download limit`);
      }
      return {
        bucket: env.B2_BUCKET,
        key,
        versionId: result.VersionId ?? versionId ?? null,
        contentType: result.ContentType ?? null,
        metadata: result.Metadata ?? {},
        body: Buffer.from(bytes),
      };
    });
  } catch (s3Error) {
    try {
      nativeB2Preferred = true;
      return await nativeGetB2Object({ key, versionId, maxBytes });
    } catch (nativeError) {
      throw new AggregateError([s3Error, nativeError], 'Backblaze B2 download failed through S3 and native APIs');
    }
  }
}

export async function deleteB2Object({ key, versionId = undefined }) {
  if (nativeB2Preferred) {
    const resolved = versionId ? { authorization: await authorizeNativeB2(), info: { fileId: versionId } }
      : await nativeFileInfo(key);
    await nativeDeleteVersion(key, resolved.info.fileId, resolved.authorization);
    return { bucket: env.B2_BUCKET, key, versionId: resolved.info.fileId, deleted: true };
  }
  try {
    return await measureExternalProvider('backblaze-b2', 'delete-object', async () => {
      await getStorageClient().send(
        new DeleteObjectCommand({ Bucket: env.B2_BUCKET, Key: key, VersionId: versionId }),
        { abortSignal: AbortSignal.timeout(env.PROVIDER_REQUEST_TIMEOUT_MS) },
      );
      return { bucket: env.B2_BUCKET, key, versionId: versionId ?? null, deleted: true };
    });
  } catch (s3Error) {
    try {
      nativeB2Preferred = true;
      const resolved = versionId ? { authorization: await authorizeNativeB2(), info: { fileId: versionId } }
        : await nativeFileInfo(key);
      await nativeDeleteVersion(key, resolved.info.fileId, resolved.authorization);
      return { bucket: env.B2_BUCKET, key, versionId: resolved.info.fileId, deleted: true };
    } catch (nativeError) {
      throw new AggregateError([s3Error, nativeError], 'Backblaze B2 deletion failed through S3 and native APIs');
    }
  }
}

export async function deleteAllB2ObjectVersions({ key }) {
  if (nativeB2Preferred) return nativeDeleteAllVersions(key);
  try {
    return await measureExternalProvider('backblaze-b2', 'delete-object-versions', async () => {
    let keyMarker;
    let versionIdMarker;
    let deletedCount = 0;
    let truncated;
    do {
      const listed = await getStorageClient().send(new ListObjectVersionsCommand({
        Bucket: env.B2_BUCKET,
        Prefix: key,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
        MaxKeys: 1000,
      }), { abortSignal: AbortSignal.timeout(env.PROVIDER_REQUEST_TIMEOUT_MS) });
      const entries = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])]
        .filter((entry) => entry.Key === key && entry.VersionId);
      for (const entry of entries) {
        await getStorageClient().send(new DeleteObjectCommand({
          Bucket: env.B2_BUCKET, Key: key, VersionId: entry.VersionId,
        }), { abortSignal: AbortSignal.timeout(env.PROVIDER_REQUEST_TIMEOUT_MS) });
        deletedCount += 1;
      }
      truncated = Boolean(listed.IsTruncated);
      keyMarker = truncated ? listed.NextKeyMarker : undefined;
      versionIdMarker = truncated ? listed.NextVersionIdMarker : undefined;
      if (truncated && !keyMarker && !versionIdMarker) {
        throw new Error('B2 object-version listing was truncated without continuation markers');
      }
    } while (truncated);
    return { bucket: env.B2_BUCKET, key, deletedCount, deleted: true };
    });
  } catch (s3Error) {
    try {
      nativeB2Preferred = true;
      return await nativeDeleteAllVersions(key);
    } catch (nativeError) {
      throw new AggregateError(
        [s3Error, nativeError],
        'Backblaze B2 version deletion failed through S3 and native APIs',
      );
    }
  }
}
