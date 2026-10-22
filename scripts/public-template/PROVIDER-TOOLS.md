# Tools on your account connections

Exomina uses each provider's official client. The models and tools offered by
that client depend on your account, plan and provider limits. Choose the provider
in chat, then describe what you want to do. Work that needs tools opens Exomina's
full tool mode; the permission level and rules you selected still apply.

The AI can read **Notes → Overview** directly with `notes_overview`, including
topic summaries, item IDs, source excerpts and a warning when source notes have
changed. This read is available in ordinary chat and read-only follow-up answers.
Only currently shared notes are eligible; a task authorized for one selected note
passage cannot use it to read the whole notebook.

Notes → Overview has one searchable, expandable card per topic. With
`notes_overview_cleanup`, the AI removes verified implemented or explicitly
discarded ideas from the overview and their source notes together. It supplies the
current overview snapshot, evidence, revised summaries and exact complete source
passages when the saved excerpt is too short. Mixed passages containing retained
ideas are refused. Approval previews show the exact removals; source-note sharing,
revisions and deny rules are rechecked before saving. Unrelated writing, links and
work chats remain. **Undo cleanup** restores both notes and overview, including
emptied notes. Later source edits block Undo from overwriting newer text.

| Connection | Tools in Exomina | Media |
| --- | --- | --- |
| ChatGPT / Codex | Native Codex tools, plus Exomina's browser, desktop, file and memory tools | Native image generation and editing when the client, model and account support it. ChatGPT Realtime voice has its own voice control. |
| Claude / Claude Code | Native Claude Code tools, plus Exomina's shared tools | Image input. Claude's client does not provide a native image or video generator through this connection. |
| Grok / Grok Build | Exomina's shared tools and native Imagine tools | Create and edit images, or generate videos from images and references. Attached images are passed to Imagine as checked files. Reading an image in an ordinary chat also needs image support in the Grok client. Grok checks your plan and remaining usage when you request media. |
| Antigravity | Exomina's shared browser, memory, file and question tools through a scoped MCP bridge. Native file, URL and command tools are disabled. | Full tool mode reads attached images through Exomina's attachment tool. Tool-free helpers accept text only. Authenticated image understanding still needs live verification. Google's image and video generators are accessed through Gemini's website; see below. |
| Muse Code | Native Muse file tools, plus Exomina's shared terminal, browser, desktop, file, memory and archive tools through an authenticated local MCP bridge | Image input. Models and effort settings come from your signed-in Muse account. |

## Shared skills, pipelines and workers

`skill_library` discovers reusable procedures shared with this saved chat.
Catalogue entries contain metadata; `read` loads a specific revision or named
reference with pagination. Creating, revising and retiring content use normal
write permissions. Project or all-chat sharing always asks for explicit
confirmation. Private chats and scoped note tasks cannot use the library.

`tool_pipeline` runs a validated sequence of read-only host tools and applies
literal filters or safe field projections. Each source call follows the normal
dispatcher and permission rules. It cannot run code, shell commands or external
mutations. Retained raw workspace results expire and require fresh source
authorization in the same live run; other sources are reopened through their
original tools.

`worker_run` lists configured Docker and SSH workers and runs an approved job.
Configure workers under Settings. Docker images must already exist locally and
be pinned by digest. SSH requires previously configured access and known host
keys. The host never installs a worker runtime or falls back to local execution
when a worker is unavailable. Every job requires explicit approval.

## Using Muse Code

Open **Connections → Muse Code → Sign in**, and approve the device code through Meta using the account with your Muse Code subscription. After sign-in, choose **Muse Code** in the chat model picker. The list comes from the official client, including **Muse Wonder** and **Muse Wonder Full** when your account offers them. Their reasoning effort choices appear beside the model. Power uses its subscription allowance; this connection removes Meta API keys from the runtime environment and has no API-key fallback.

Exomina starts Muse with Contributor mode explicitly **off**. Native permissions and Exomina’s own shared-tool approvals still apply. Each request receives a fresh bounded view of the current chat and shared memory; switching providers keeps the Exomina conversation. Stop interrupts the native turn. Muse is currently available for normal chats with tools; strictly tool-free background helpers use other eligible connections. Model access and remaining usage are decided by Meta when you send.

Muse uses Exomina’s `workspace_shell` for commands and builds. Its native PowerShell tool is disabled because its Windows sandbox failed to enter the encrypted workspace and added helper-account ACLs to its protected profile. The shared terminal runs with your Windows account permissions, **not an OS sandbox**. It starts in the selected chat folder and applies the chat’s permission level and deny rules; Ask mode requests command approval and Full access follows your existing grant. Account keys are removed from its environment. This route does not call an OpenAI model or change Muse billing. Exomina keeps EFS encryption enabled and does not offer an automatic sandbox fallback.

A live synthetic Wonder Full reply and a separate Wonder call through Exomina’s authenticated MCP bridge were verified on 2026-10-12. This does not establish that every native Muse tool, image workflow or future account entitlement works.

## Using Grok Imagine

Select **Grok** and ask it to create an image or video. For an edit or animation,
attach the image and describe the change. Imagine uses the Grok account you
connected; an xAI API key is a separate connection with separate billing.

Successful PNG, JPEG, WebP and MP4 outputs appear in chat. Videos have playback
controls. Use **Save image** or **Save video** to keep a copy. Each output can be
up to 20 MiB. Attachment metadata survives chat export, and stored media uses
Exomina's existing asset storage and sync.

Imagine requests follow Exomina's permission rules and include the proposed
prompt in the approval details. Stop cancels the native turn and prevents late
media from being added to the reply. If Grok refuses a request because of your
plan or limits, the connection keeps that provider's billing route.

## What a subscription does not automatically expose

A feature available on a provider's website may have no supported interface in
its official client. This integration does not provide every website feature,
such as every hosted research workflow or video product. API and local-model
connections expose the capabilities of the endpoint you configure.

You can explicitly request ChatGPT image generation from another provider's
chat. Exomina asks before sending the image prompt to ChatGPT, and that request
uses your ChatGPT connection and limits.

## Google images and videos

Exomina's Google account connection uses **Antigravity CLI** with Google's own
manual URL/code sign-in in a protected Exomina profile, following Google's
[remote-terminal OAuth flow](https://antigravity.google/docs/cli/install/#remote-ssh-oauth-flow).
Copy the CLI's secure URL into your normal browser, then paste the code directly
into the CLI window. Exomina does not read the code. Its shared tools use Exomina's permission
controls through a per-turn MCP bridge. Full tool mode exposes supplied image
pixels through an attachment-reading tool; the headless CLI itself accepts text
only, so tool-free helpers cannot read images. Bounded text attachments are
included in the prompt; other files use Exomina's file tools. Native CLI file,
URL and command tools are disabled, and automatic Google credits are disabled.
Only one Antigravity turn or sign-in window uses this profile at a time. Close
the sign-in window after Google login, then refresh the connection. The bridge
and native MCP configuration discovery are verified; authenticated model tool
use, image understanding and native permission enforcement remain unverified.
The image and video features in the **Gemini website** are a separate part of
Google's service, even when your plan includes both.

The old Gemini CLI connection and runtime have been removed. Existing chats
continue with Antigravity's default model; their original messages are retained.
Typing “Gemini” finds Antigravity. The separate Gemini API connection still uses
API quotas and billing.

Google AI plans include media creation on [Gemini's website](https://support.google.com/gemini/answer/16126339?hl=en&co=GENIE.Platform%3DDesktop).
Use **Connections > Antigravity > Open Gemini for images & videos** to open it in the
browser selected in Exomina. You can work with Google's own interface using your
plan, and download the result using that browser's normal download controls.
Generated Google media is not automatically added as an Exomina chat attachment.

To use the Google account already signed in to Chrome or Edge, open **Tools >
Website sign-ins > Connect Chrome or Edge**. Follow the extension setup, then
choose **Use my browser**. Exomina's browser tools can work in that signed-in
profile after the usual approvals. Each chat has its own browser tab. No Google
passwords or browser cookies are copied into Exomina.

The newer [Antigravity SDK](https://antigravity.google/docs/sdk/overview/) lists
image tools, but its documented setup uses a Gemini API key or Google Cloud
credentials. That does not establish access to the media allowance in a personal
Google AI plan. Exomina has no direct Google subscription image/video tool and
never substitutes API billing for a subscription request.

## Provider references

- [OpenAI App Server](https://learn.chatgpt.com/docs/app-server)
- [Claude Code tools and extensions](https://code.claude.com/docs/en/features-overview)
- [Grok Build commands](https://docs.x.ai/build/modes-and-commands.md)
- [Antigravity CLI](https://antigravity.google/docs/cli/install/)

## App analysis with REA

Tools → App analysis → Inspection reports selects a file or folder for the current chat. Every provider that supports Exomina tools can call `analysis_status`, `analysis_run`, `analysis_native`, `analysis_report`, `analysis_read` and `analysis_search` to inspect that selection. No extra API connection is required. A selected target uses the full tool suite, and the target files remain source data, never instructions. Tools apply the chat permission policy and deny rules. REA 6.1.0 is bundled and pinned. Static operations cover JavaScript/Electron inspection, .NET metadata/members/native declarations, file inventories, and native Windows executable inspection through optional Ghidra. It runs against bounded snapshots and has cancellable progress and local JSON reports. Native workers use the verified Node 24.22.1 runtime bundled with Exomina. Native setup is a user action in Tools: select the Ghidra and full Java JDK installation folders and check their reported availability. The experimental workflow currently supports native Windows x86/x64 EXE files. Native DLLs, other binary formats and other architectures are not yet integrated and verified in Exomina; Ghidra itself supports a wider range of targets. Managed EXEs and DLLs use the separate .NET inspections. `analysis_run` operations `native` and `native-functions` produce an overview or bounded decompilation, with an optional function name/address `procedure` for the latter. `analysis_native` exposes supported read-only Ghidra queries for deeper investigation. The selected executable is never launched. Runtime capture and Hopper are not enabled; reconstructed source can be incomplete. Results read by an AI are sent to its provider.

## Ghidra projects within App analysis

Tools → App analysis has two modes with one target selection and native dependency setup. **Inspection reports** uses the analysis_* tools to produce read-only evidence for JavaScript/Electron, .NET and native EXEs. **Ghidra project** uses GhidraMCP 2.0 with Ghidra 12.1.4 and a full JDK for persistent analysis of a single Windows x86/x64 EXE. Native inspection reports use Ghidra separately and do not include edits made in the persistent project. Keep the two tool families distinct when choosing an operation.

Select an EXE with the shared **Choose file** button, open **Ghidra project**, then start or resume the project. Shared tools ghidra_status and ghidra_query inspect the derived project; ghidra_edit changes address-bound names, comments, prototypes and local variable types after edits are enabled and each change is approved. Reads preserve bounded pagination. Every edit saves a .gzf recovery checkpoint. The persistent project is keyed by chat and binary SHA-256. Original binaries are never executed or changed. The integration communicates over the owned Java process pipes; it starts no GhidraMCP HTTP listener and needs no Python bridge. Other formats and attachment to existing GUI projects are not part of this integration.

## Muse subscription usage

Muse Code appears in the sidebar usage summary and in Settings → Usage. The details show the 5-hour and weekly subscription windows, remaining percentages, reset times and the last native observation. Muse exposes last-observed quota, not an independently refreshed account endpoint: Exomina reads active Muse runtimes and captures the reading after a reply, then retains only quota metadata in its encrypted profile. Older readings are marked stale. Refresh never sends a model prompt or switches to API billing.
