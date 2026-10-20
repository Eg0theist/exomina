# Terminal

Open **Terminal** in Advanced view, or show the Terminal panel in Workspaces.

## Interactive sessions

Choose **New interactive session** for a real Windows ConPTY PowerShell shell
starting in your Windows user folder (`%USERPROFILE%`). Choose **Open in workspace**
to start in the chat's current project/workspace folder instead. Existing sessions
keep their current directory when you reopen or move the panel. The panel labels
the starting folder; the PowerShell prompt shows its current folder.
Working directory, variables and interactive applications persist until
you close the session. The terminal supports keyboard input, resizing, Ctrl+C
and a separate Close session action. Closing or floating the panel keeps the
session running; closing Exomina ends its owned sessions. There is no automatic
process recovery after restart.

Interactive sessions follow the chat's permission level. Ask and Auto-edit
request a whole-session shell grant; a command-prefix allowance cannot replace
that grant. Full access opens sessions without an extra prompt. Read only mode
and command deny rules block interactive shells because raw terminal input
cannot be checked as individual commands. A terminal has the Windows user's file and process
permissions; its starting folder is not an OS sandbox. Host
credential environment variables and shell startup profiles are not passed in.

Sessions belong to one saved desktop chat and its canonical workspace. Input
is serialized and bounded. Policy, privacy and workspace changes revoke access.
Output has a bounded in-memory ring buffer; truncation is reported explicitly.
Terminal control sequences cannot silently write the clipboard or open links.

## Agent commands

For interactive work, agents can use `terminal_open`, `terminal_read`,
`terminal_input`, `terminal_resize` and `terminal_close`. The resulting
**Shared with AI** session starts in the task workspace and appears in Agent commands. You can view and type
into that same session, interrupt it or close it. AI tools cannot access a
user-owned terminal by guessing its handle. Shell output is untrusted source
data, and only output explicitly read by the AI enters its tool context.

Native provider terminals are separate. When the connected Codex runtime
supports its native background-terminal API, this panel can list the current
thread's terminals and stop an individual one through the provider protocol.
Existing private provider commands do not expose an attachable stdin channel.
Their command receipts remain available below; unsupported providers report
their capability explicitly. Stop agent task still stops the full chat task.

## Direct commands

The original bounded command console remains available. Each command starts a
fresh hidden process in the chat's workspace, obeys the existing permission
level, deny rules and approval controls, and has its own Stop control and time
limit. Directory changes and variables do not carry into the next command.

Up to 20 recent direct command transcripts share an in-memory history limit,
with up to 262,144 visible characters each. A zero exit code reports process
completion and does not independently verify the command's intended effects.
