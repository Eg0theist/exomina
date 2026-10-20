# Exomina beta

Your AI tools in one desktop app, with continuing chats, shared memory, a visible browser and tools for getting work done.

**Exomina is open source, and you are encouraged to build upon it.** Explore the code, modify it, fork it, and create and distribute your own versions, including commercial projects, under the [Apache License 2.0](LICENSE). Contributions back are welcome, but optional. Preserve the required licence, copyright and attribution notices. Third-party components retain their own licences and service terms.

**Start with the [quick-start guide](START-HERE.txt)** or [download the current beta](https://github.com/Eg0theist/exomina/releases/tag/v0.5.0-beta.94). Install on Windows 10/11 x64 including Home, Intel or Apple Silicon Macs, and Debian/Ubuntu x64 or ARM64. Node.js and developer tools are not needed.

Fresh profiles open in Standard view. Connect an AI, review tools and access, then try a small task. **Learn Exomina** is on the home screen in both views, beginning with your first conversation. Advanced view exposes additional controls without changing permissions.

The current beta includes library backup and restore, memory corrections and source dates, automatic work plans, phone and Discord workflows, character controls, and interface scaling. A local model is an option after separately installing its server and model files. Provider account access, plans and API charges remain your own.

Windows builds are unsigned; Macs are not notarized. Read the exact release's **VALIDATION.md** for checks and remaining limits. Phone access needs the computer, app and relay online.

- [Installation and data](BETA.md)
- [Platform support](SUPPORT.md)
- [Feedback](FEEDBACK.md)
- [Build from source](BUILDING.md)
- [Third-party notices](THIRD-PARTY-NOTICES.txt)

## Acknowledgements

Exomina owes a particular debt to [Victor Taelin](https://github.com/VictorTaelin), his [UniiChat](https://github.com/VictorTaelin/UniiChat) and [OptMem](https://github.com/VictorTaelin/OptMem) projects, and his [proposal for a chat that never ends](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449). His work helped make this project possible and shaped its approach to continuing conversations and persistent memory.

The central ideas are compact hierarchical summaries, a bounded view of a much larger history, and the ability to open the original source when details matter. OptMem also provides a model for short durable notes, an append-only source log and summaries that can be rebuilt without discarding those originals.

Exomina builds on these ideas in a local-first desktop application: separate memory trees for conversations, continuity across AI providers, shared saved notes, known message dates and correction links, and configurable sharing and tool permissions. It combines that memory with a visible browser, files, work plans and other integrated workflows. See [Whole-chat memory](CHAT-MEMORY.md) for the implementation and its limits.

**Support Exomina's development via PayPal: @egotheist.** Contributions help fund continued development and testing.
