# Agent speech phrase rules

Open an agent, choose **Listener (STT)**, and scroll below the interruption controls to **Speech Phrase Rules**. Add phrases with **+ Add** or Enter, remove them with the chip's remove button, and use **Save Changes**. The rules apply to new calls, including browser test calls.

- Minimum Meaningful Words defaults to 2. The selector offers 1, 2, or 3; an existing higher saved value is preserved.
- Phrase matching accepts a whole transcript composed of saved phrases from the same list, including repetitions: `ஹலோ ஹலோ` matches saved `ஹலோ`, and `ஓகே ஓகே` matches saved `ஓகே`. Different spellings/languages must be added separately (`okay` does not implicitly match `ஓகே`). No language-specific runtime aliases are used.
- Continue phrases suppress interruptions during agent output, but remain valid answers while the agent is listening. A longer utterance containing additional words, such as `okay but tell me the price`, is evaluated normally. Delayed final acknowledgements that began during playback do not create an extra reply after playback finishes.
- Explicit stop phrases interrupt immediately regardless of the word threshold. The final stop phrase is saved in the transcript and leaves the agent listening; it does not hang up or generate another LLM reply.
- Call-check phrases use the separately saved short response after the final transcript arrives. Existing output is canceled before the response plays. Both caller and agent text are saved; Knowledge Base and LLM processing are bypassed. An empty response disables this shortcut.
- If phrases overlap, explicit stop takes precedence, then call check, then continue.
- With phrase rules configured, speech duration alone cannot interrupt. Ordinary partial transcripts must meet the word threshold and confirmation delay; final transcripts can confirm immediately. This waits for STT rather than cutting off a long acknowledgement before its words arrive.

The editor provides the requested Tamil and English starter phrases. Lists, including explicitly empty lists, are saved per agent. Speech recognition spelling variants can be added as separate phrases. No database migration is needed: these values use the existing agent settings field.
