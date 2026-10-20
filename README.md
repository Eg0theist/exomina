# Exomina beta

**Make the software you wish existed.** Exomina brings ChatGPT, Claude, Gemini, Grok and local models into one free, open-source desktop workspace that remembers your work, edits your real files, browses the web and keeps going when one AI runs out of messages.

- **Stop re-explaining yourself.** Long conversations keep a memory with links back to the original messages, and shared notes carry your preferences and decisions into new chats.
- **Stop copy-pasting between AIs.** Switch the model or provider inside a conversation; the history, attachments and project context stay where they are.
- **Stop waiting for limits to reset.** When one plan runs dry, continue with another connected AI in the same chat.
- **Stop being the AI's hands.** Let it read and edit project files, run commands, research in a visible browser, inspect an application or follow a work plan under the access you choose.

Your chat library stays on your computer; content sent to a cloud provider is processed by that provider.

**[Website](https://eg0theist.github.io/exomina/)** · **[Download the current beta](https://github.com/Eg0theist/exomina/releases/tag/v0.5.0-beta.94)** · [Quick start](START-HERE.txt) · [Installation](BETA.md) · [Platform support](SUPPORT.md)

Open source under [Apache-2.0](LICENSE). Forks, modifications and your own versions are welcome.

## What could you make?

- **Build software around your own habits.** A writing tracker, a personal dashboard or a desktop utility, with the screens and behavior you actually want.
- **Rethink a subscription.** Build a focused alternative to the parts of a SaaS product you use, where practical. Start small, test it and account for data, integrations and maintenance before relying on it.
- **Research and decide.** Let it read the pages in a browser you can watch, collect what matters for your question with sources, and give a recommendation you can check.
- **Change your game.** Develop a mod for a supported game: adjust a mechanic, test it locally and refine how it feels.

These are projects to develop and check, rather than a promise that any idea works in one prompt. The same workspace also supports writing, file work, browser tasks and other everyday work.

## Start with a new conversation

1. Install Exomina and open **Connections**.
2. Connect the provider you want to use and complete its setup or official sign-in.
3. Review tools and access, then send your first message.

**You do not need to import conversations, context or memories.** Start with an empty library; importing earlier material is optional. Fresh profiles open in Standard view, with **Learn Exomina** on the home screen. Its 13 walkthroughs begin with your first conversation. Advanced view adds controls for models, tools and workflows without changing your permissions.

Installers are available for Windows 10/11 x64 including Home, Intel and Apple Silicon Macs, and Debian/Ubuntu x64 or ARM64. You do not need Node.js or developer tools to use the app. ChatGPT and Grok clients are included. Claude is an opt-in connection through your own official Claude Code client; Gemini and Muse need their clients installed separately. Provider access, plans, limits and API charges apply to your own account. Local models need a separate server and model download.

## What you can do

### Continue across providers without starting over

Switch the model or provider inside a conversation and keep working with its saved history, attachments and project context. Use subscription connections, separately billed API connections, or a supported local model server. Check available models and reported usage in the app, and choose the level of reasoning appropriate to the task.

Long conversations have a memory tree with compact summaries and links back to the original messages. The AI can search earlier work, open the source and check dates instead of relying on a short recap. Shared saved notes carry useful facts and decisions between chats when sharing is enabled. Review, correct or delete those notes, and keep particular chats private.

### Work on files, code and local projects

Give a chat a workspace and let the AI inspect files, propose changes, edit code and run commands under the access level you choose. Use the integrated terminal for interactive work, including sessions you and the AI can both see. Keep related chats and instructions together in projects, attach supporting files, and return to the result later.

For example: ask it to investigate a bug, make the change, run the relevant checks and explain what was actually verified. Commands run with your operating-system account's access, so choose the workspace and permissions accordingly.

### Research and act in a visible browser

Open websites alongside the conversation. The AI can read pages, follow links, fill fields and inspect the page's loaded HTML, JavaScript and CSS through the enabled browser tools. Use the built-in browser or a supported connected browser, with the existing sharing and approval controls.

This supports tasks such as comparing information from several pages, investigating how a website works, or carrying out an approved web workflow while you can see the page.

### Inspect applications and storage

App analysis can inspect JavaScript/Electron applications, .NET metadata and supported native Windows executables. Native Windows x86/x64 EXE inspection and persistent Ghidra projects require a separate Ghidra installation and full Java JDK. Static analysis does not launch the selected executable; supported formats and analysis limits are described in [Provider tools](PROVIDER-TOOLS.md#app-analysis-with-rea).

The Storage view shows large folders and files, file types, ages and cleanup candidates. Review an AI's proposed cleanup or select items yourself. Deletion uses a confirmation step and defaults to the Recycle Bin where supported.

### Let a task continue while you steer

Work plans help break a larger task into steps and track its progress. Ask follow-up questions or add a direction while a reply is still running. Persistent question cards and approval controls keep decisions visible, and scheduled tasks can run supported work while the computer and app are available.

Optional computer-control tools can interact with supported desktop applications. Available actions and required system permissions depend on the platform. Tool access remains configurable per chat; browser content, files and imported text are treated as source material rather than instructions that override your decisions.

### Use voice and create media

On Windows, dictate a message or have replies read aloud. Eligible ChatGPT connections can use Realtime voice. Ask supported ChatGPT models for image generation or editing, or use Grok Imagine for images, edits and videos when your account and client support them. Returned media appears in the conversation and can be saved.

These features depend on the provider, plan, client and operating system. See the [provider capability guide](PROVIDER-TOOLS.md) for the distinctions, including image input, generation and voice support.

### Pick up work from your phone or Discord

Phone access lets you continue a conversation, steer work and respond to supported questions or approvals through a paired browser. Discord has its own paired-account access level and a `/help` command. Your computer, Exomina and the relevant relay or messaging connection must remain online.

### Keep the workspace yours

Choose themes, interface and text size, reduced motion, keyboard controls, and personality, avatar or companion settings. Back up and restore your actual chat library, memories and attachments. Import supported earlier conversation archives when you want them, with no import requirement for ordinary use.

## Your data and access

Conversations and app data are stored locally. A connected cloud model receives the messages, attachments and tool results shared with it. Local-model connections are available for workflows that use your own model server.

Start with **Ask** if you want to review actions before they happen. Adjust a chat's access, turn individual tools on or off, and control which notes, files and browser content are shared. Standard and Advanced views change the interface, not the permission level.

Fresh profiles use private user permissions and protected operating-system storage for supported saved connection keys. Standard mode does not encrypt every chat or provider-runtime file. Read [Installation and data](BETA.md#your-data) for storage locations, optional Windows encryption and backup guidance.

## Beta status

Exomina is in active development. Windows builds are unsigned and Mac builds are not notarized. Some features require a compatible provider account, separately installed tools or platform permissions. The exact release's **VALIDATION.md** records the checks performed and remaining limits, including live-account, audio and physical-device testing.

- [Installation and updates](BETA.md)
- [Platform support and troubleshooting](SUPPORT.md)
- [Provider tools and capabilities](PROVIDER-TOOLS.md)
- [Terminal usage](TERMINAL.md)
- [Feedback and bug reports](FEEDBACK.md)
- [Build from source](BUILDING.md)
- [Third-party notices](THIRD-PARTY-NOTICES.txt)

## Open source

**You are encouraged to build upon Exomina.** Explore the code, modify it, fork it, and create and distribute your own versions, including commercial projects, under the [Apache License 2.0](LICENSE). Contributions back are welcome, but optional. Preserve the required licence, copyright and attribution notices. Third-party components retain their own licences and service terms.

## Acknowledgements

Exomina owes a particular debt to [Victor Taelin](https://github.com/VictorTaelin), his [UniiChat](https://github.com/VictorTaelin/UniiChat) and [OptMem](https://github.com/VictorTaelin/OptMem) projects, and his [proposal for a chat that never ends](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449). His work helped make this project possible and shaped its approach to continuing conversations and persistent memory.

The central ideas are compact hierarchical summaries, a bounded view of a much larger history, and the ability to open the original source when details matter. OptMem also provides a model for short durable notes, an append-only source log and summaries that can be rebuilt without discarding those originals.

Exomina builds on these ideas in a local-first desktop application: separate memory trees for conversations, continuity across AI providers, shared saved notes, known message dates and correction links, and configurable sharing and tool permissions. It combines that memory with a visible browser, files, work plans and other integrated workflows. See [Whole-chat memory](CHAT-MEMORY.md) for the implementation and its limits.

**[Support Exomina's development via PayPal: @egotheist](https://www.paypal.com/paypalme/egotheist).** Contributions help fund continued development and testing.
