# Claude File Manager MCP

An MCP server for Claude that can create, read, edit, copy, move and delete
files and folders — plus images, bulk replacements, ZIP archives, a compact
project tree, and an optional terminal with background processes.

It runs locally over `stdio`, without internet access or third-party services.

## Features

| Tool               | What it does                                             |
| ------------------ | -------------------------------------------------------- |
| `list_roots`       | Shows the allowed folders (one or several)               |
| `list_directory`   | Lists folder contents (optionally recursive)             |
| `list_tree`        | Draws a compact project tree                             |
| `read_file`        | Reads a text file, PDF text or a Jupyter notebook; optional range |
| `read_image`       | Shows a PNG/JPEG/GIF/WebP image to Claude                |
| `write_file`       | Creates or overwrites a file                             |
| `append_file`      | Appends text to the end of a file                        |
| `edit_file`        | Replaces an exact fragment and shows a diff              |
| `multi_edit`       | Several replacements in one call, atomically             |
| `edit_notebook`    | Replaces, inserts or deletes a cell in a .ipynb notebook  |
| `replace_in_files` | Replaces text across many files, with one undo step      |
| `create_directory` | Creates a folder with all missing parents                |
| `move_path`        | Moves or renames a file/folder                           |
| `copy_path`        | Copies a file or folder                                  |
| `zip_path`         | Packs files and folders into a ZIP archive               |
| `unzip_path`       | Extracts a ZIP archive into a folder                     |
| `delete_path`      | Moves to trash (or permanently with `permanent=true`)    |
| `file_info`        | Shows type, size and dates of a file/folder              |
| `find_files`       | Finds files by glob or name substring, newest first      |
| `search_content`   | Searches text/regex; content, file list or count mode    |
| `list_trash`       | Shows the trash                                          |
| `restore_path`     | Restores a file/folder from the trash                    |
| `undo_last_change` | Undoes the last change (up to 20 steps)                  |
| `run_command`      | Runs a terminal command (optional, off by default)       |
| `start_process`    | Starts a background command (optional, off by default)   |
| `read_output`      | Reads the output of a background process                 |
| `stop_process`     | Stops a background process and its children             |
| `list_processes`   | Lists background processes of this session              |

That is 28 tools with the terminal enabled and 23 without. The five terminal
tools are disabled unless `MCP_ALLOW_SHELL=1` is set. All other tools work with
files only.

## Windows installation (prebuilt installer)

Download **[ClaudeFileManager-Setup-1.5.0.exe](https://github.com/sadd11/claude-file-manager-mcp/releases/latest)**.

1. Run the installer. If Windows shows the blue SmartScreen window, click
   **More info → Run anyway** (the file has no digital signature).
2. It installs without administrator rights into
   `%LOCALAPPDATA%\ClaudeFileManager`. Node.js is bundled — nothing else
   needs to be installed.
3. On the last screen the installer shows the instructions and offers
   **"Run setup now"**.
4. In the browser choose a folder → **Use this folder** → **Connect to Claude
   Desktop** → restart Claude Desktop.

"Claude File Manager" shortcuts appear in the Start menu and (optionally) on
the desktop. Uninstall via **Settings → Apps**.

**Portable version:** **[ClaudeFileManager-Portable-1.5.0.zip](https://github.com/sadd11/claude-file-manager-mcp/releases/latest)** —
extract anywhere and run `start-ui.cmd`. No installation required.

## macOS and Linux

There are two ways to install on macOS:

### DMG installer (drag to Applications)

Download **[ClaudeFileManager-1.5.0.dmg](https://github.com/sadd11/claude-file-manager-mcp/releases/latest)**,
open it and drag **Claude File Manager** onto the **Applications** folder.
The app bundles its own Node.js — nothing else needs to be installed.

Opening it starts the local setup page (`http://127.0.0.1:4317`) in your
browser: pick a folder and click **Connect to Claude Desktop**, then fully
quit (⌘Q) and reopen Claude Desktop.

The app is not signed with an Apple Developer certificate, so macOS will ask
for a one-time confirmation. If it refuses to open, run once in Terminal:

```bash
xattr -cr "/Applications/Claude File Manager.app"
```

and open it again.

### Portable (macOS and Linux)

**[ClaudeFileManager-Portable-1.5.0-macOS.zip](https://github.com/sadd11/claude-file-manager-mcp/releases/latest)**
also works on Linux. Node.js 18+ is the only requirement — `brew install node`
on macOS, or your package manager on Linux.

1. Unzip it anywhere (for example `~/claude-file-manager`).
2. In Terminal: `cd` into the folder and run `sh start-ui.command`
   (or `chmod +x start-ui.command` once, then double-click it).
   If macOS Gatekeeper complains about a downloaded script, right-click the
   file → **Open**, or just run it with `sh` as above.
3. The setup page `http://127.0.0.1:4317` opens — pick a folder and click
   **Connect to Claude Desktop**. The UI writes the config to
   `~/Library/Application Support/Claude/claude_desktop_config.json`
   (creating a backup first) and shows the JSON for manual editing.
4. Fully quit Claude Desktop (⌘Q) and reopen it.

Manual config for macOS:

```json
{
  "mcpServers": {
    "files": {
      "command": "node",
      "args": ["/Users/you/claude-file-manager/src/index.js"],
      "env": {
        "MCP_FILE_ROOT": "/Users/you/your-project"
      }
    }
  }
}
```

On macOS/Linux several roots are separated by `:` in `MCP_FILE_ROOTS`, and the
terminal tool runs commands through `/bin/sh` (`MCP_SHELL=bash` for bash).
Everything else — tools, trash, backups, undo, the setup UI — is identical.
Every push is smoke-tested on macOS, Linux and Windows runners in CI.

### Building the installer

```powershell
winget install --id JRSoftware.InnoSetup -e
npm run build:installer
```

The output appears in `installer\out`. The script copies the Node runtime,
installs production dependencies, draws the icon and builds the `.exe`, the
Windows portable `.zip` and the macOS/Linux portable `.zip`.

## Run from source

```powershell
git clone https://github.com/sadd11/claude-file-manager-mcp.git
cd claude-file-manager-mcp
npm install
```

## Setup through the UI (recommended)

```powershell
npm run ui
```

Or double-click `start-ui.cmd`.

The page `http://127.0.0.1:4317` opens:

1. Choose a folder — browse drives and subfolders, paste a path manually, or
   click **Browse…** and pick a folder in the system dialog.
2. Click **Use this folder**.
3. Optionally add more folders under **Additional folders** — Claude can then
   work in all of them, and can choose the right one itself.
4. Click **Connect to Claude Desktop**.
5. Fully close and reopen Claude Desktop.

The UI also provides:

- **Check server** — actually starts the MCP server and lists the working
  tools;
- a "Connected to Claude Desktop" indicator that shows which folders are used;
- a list of recent folders;
- a **History and recovery** section with Trash, Backups, Commands and
  Activity tabs — deleted items and file versions can be restored with one
  click, without writing a prompt;
- an **Open** button that reveals the selected folder in Explorer;
- an "Allow terminal commands" switch (see below);
- the JSON config and a ready-made Claude Code command.

The button **Connect to Claude Desktop** replaces the whole content of
`%APPDATA%\Claude\claude_desktop_config.json` with the canonical JSON shown
in the preview — hand-added env keys of the `files` server are kept, other
servers are removed. A backup of the previous file is always saved next to it
(`claude_desktop_config.json.bak-…`).

Keep the console window open while you use the UI. Stop it with `Ctrl+C`.

### Manual setup

Check that the server starts:

```powershell
npm start
```

The server starts and waits for JSON-RPC on stdin — this is expected; nothing
must be written to stdout. Stop it with `Ctrl+C`.

## Connecting to Claude Desktop manually

1. Open the config file:
   `%APPDATA%\Claude\claude_desktop_config.json`
   (create it if it does not exist).
2. Add the server:

```json
{
  "mcpServers": {
    "files": {
      "command": "node",
      "args": ["C:\\path\\to\\claude-file-manager-mcp\\src\\index.js"],
      "env": {
        "MCP_FILE_ROOT": "C:\\path\\to\\your\\project"
      }
    }
  }
}
```

3. Fully close and reopen Claude Desktop.
4. A tools icon appears in the chat — the `files` server is ready.

> `MCP_FILE_ROOT` is the folder the server is allowed to work in. Point it at
> your project so Claude cannot accidentally change something elsewhere.
> To allow several folders, use `MCP_FILE_ROOTS` instead with paths separated
> by `;` (Windows) or `:` (macOS/Linux). Relative paths resolve against the
> first folder. Add `"MCP_ALLOW_SHELL": "1"` to `env` to enable the optional
> terminal tools.

## Connecting to Claude Code (CLI)

```powershell
claude mcp add files --scope user `
  --env MCP_FILE_ROOT="C:\path\to\your\project" `
  -- node "C:\path\to\claude-file-manager-mcp\src\index.js"
```

Verify:

```powershell
claude mcp list
```

## Trash, backups and undo

The server creates a service directory `.mcp` inside the working folder:

```
.mcp/
├─ trash/       deleted files and folders
├─ backups/     copies saved before edits
├─ trash.json   trash index
├─ activity.json change history
└─ commands.log terminal command log (if the terminal is enabled)
```

The service folder lives in the first allowed folder. With several roots,
trash, backups and history are still stored there.

- `delete_path` by default **does not destroy** the file; it moves it to the
  trash. Restore it with `restore_path` or `undo_last_change`.
- `edit_file`, `multi_edit`, `write_file` and `append_file` save a copy of the
  old version before modifying.
- `replace_in_files` backs up every changed file and records a single undo
  step, so one `undo_last_change` reverts the whole bulk replacement.
- `zip_path` and `unzip_path` can be undone when they create a new path.
- `undo_last_change` reverts the last action; several steps can be undone.
- Permanent deletion happens only with `permanent=true`.
- The setup UI shows the same trash, backups, commands and activity, with
  **Restore** buttons. A backup restore first saves the current version as a
  new backup, so it can be undone too.

> If your project is under git, add `.mcp/` to its `.gitignore`.

## Terminal tool (optional)

`run_command` lets Claude run a shell command in the chosen folder — for
example `npm test`, `git status` or a build script. It is **off by default**
so that a plain installation stays file-only.

Enable it in one of these ways:

- tick **Allow terminal commands (run_command)** in the setup UI and click
  **Connect to Claude Desktop** again;
- add `"MCP_ALLOW_SHELL": "1"` to the `env` block of the `files` server in
  the Claude Desktop config;
- pass `--env MCP_ALLOW_SHELL=1` to `claude mcp add`.

What it does:

- runs in the same allowed folder as the file tools (outside folders are
  rejected unless `MCP_ALLOW_OUTSIDE_ROOT=1`);
- returns stdout, stderr and the exit code;
- stops the command after the timeout (default 30 s, maximum 300 s) and
  kills the whole process tree;
- appends one JSON line per command to `.mcp/commands.log`.

On Windows the default shell is **Windows PowerShell** (`powershell.exe`).
The command is passed as a UTF-16LE `-EncodedCommand`, so Cyrillic and other
non-ASCII text works in arguments and output. Use PowerShell syntax:
`Get-ChildItem`, `Get-Content`, `$env:NAME`, and so on.

| `MCP_SHELL` | Shell                                             |
| ----------- | ------------------------------------------------- |
| `powershell`| `powershell.exe` (default on Windows)             |
| `pwsh`      | PowerShell 7                                      |
| `cmd`       | `cmd.exe` (legacy, non-ASCII text may break)      |
| `sh`        | `/bin/sh` (default on macOS/Linux)                |
| `bash`      | `bash` (macOS/Linux)                              |

### Background processes

For dev servers, watchers and long builds there are four more tools, enabled
by the same switch:

- `start_process` starts a command in the background and returns an id;
- `read_output` returns what it has printed so far, can wait for it to finish
  and can clear the buffer;
- `stop_process` stops it and the whole process tree;
- `list_processes` lists the processes of this session.

Up to 8 processes can run at once (`MCP_MAX_PROCESSES`), each keeps at most
100000 characters of stdout and stderr (`MCP_MAX_PROCESS_BUFFER`), and all of
them are stopped when the server exits. Starts and exits are also written to
`.mcp/commands.log`.

The terminal is **not a sandbox**. Commands run with your user rights and
every side effect is real — `rm`, `git reset --hard` and similar commands do
what they say, and the file tools' trash and undo do not cover them. Leave
the switch off unless you need it, and read a command before you approve it.

## Example prompts

- "Find all `*.tsx` files in `src`."
- "Show me the project tree two levels deep."
- "Look at `design/mockup.png` and build the same layout."
- "Find where `MCP_FILE_ROOT` is used and show two lines of context."
- "In `config.js` replace `port: 3000` with `port: 8080` and `debug: false`
  with `debug: true` — do it in one action."
- "Replace `oldName` with `newName` in every `.js` file under `src`."
- "Zip `src` and `README.md` into `release.zip`."
- "Delete `temp.log`." → the file goes to the trash.
- "Run `npm test` and show me the failures." (terminal enabled)
- "Start `npm run dev` in the background and show its output." (terminal enabled)
- "Run `git status` in this folder." (terminal enabled)
- "Restore the last deletion." / "Undo the last two changes."
- "Show the trash."
- "Create `docs/api.md` and describe the endpoints from `src/routes`."

## Settings (environment variables)

| Variable                 | Default            | Description                                          |
| ------------------------ | ------------------ | ---------------------------------------------------- |
| `MCP_FILE_ROOT`          | current directory  | Root folder inside which operations are allowed      |
| `MCP_FILE_ROOTS`         | —                  | Several allowed folders separated by `;` / `:`       |
| `MCP_ALLOW_OUTSIDE_ROOT` | `0`                | `1` — allow arbitrary paths (use with care!)         |
| `MCP_ALLOW_SHELL`        | `0`                | `1` — register the terminal and background tools     |
| `MCP_SHELL`              | `powershell` / `sh`| Shell used by `run_command` (`cmd`, `pwsh`, `bash`)  |
| `MCP_MAX_OUTPUT_CHARS`   | `200000`           | stdout/stderr capture limit per command              |
| `MCP_MAX_READ_CHARS`     | `400000`           | Character limit when reading a file                  |
| `MCP_MAX_LIST_ENTRIES`   | `5000`             | Entry limit when listing                             |
| `MCP_MAX_IMAGE_BYTES`    | `5000000`          | Largest image `read_image` will return               |
| `MCP_MAX_PROCESSES`      | `8`                | Maximum number of background processes               |
| `MCP_MAX_PROCESS_BUFFER` | `100000`           | Buffered output characters per background process    |
| `MCP_MAX_ARCHIVE_BYTES`  | `500000000`        | Size limit for ZIP sources and extraction            |
| `MCP_DATA_DIR`           | `<root>/.mcp`      | Where to store trash, backups and history            |
| `MCP_REQUIRE_READ`       | `1`                | `0` — allow editing files that were not read first   |
| `MCP_SANDBOX`            | `0`                | `1` — isolate terminal commands (Windows: AppContainer, macOS: Seatbelt) |
| `UI_PORT`                | `4317`             | Local UI port (`npm run ui`)                         |
| `UI_NO_OPEN`             | —                  | `1` — do not open the browser automatically          |

## Security

- All paths are normalized; escaping every allowed folder is blocked,
  including through symbolic links that point outside.
- Root folders cannot be deleted, moved or overwritten.
- A non-empty folder can only be deleted with `recursive=true`.
- Overwriting or copying onto an existing file requires `overwrite=true`;
  the replaced item goes to the trash, so the step is reversible
  (extracting a ZIP with `overwrite=true` is the one exception).
- A folder cannot be moved or copied into itself or its own subfolder.
- A file must be read before it is edited or overwritten, and it must not
  change between the read and the edit — stale edits are refused
  (turn this off with `MCP_REQUIRE_READ=0`).
- Permanent deletion asks for explicit confirmation through the MCP client
  (elicitation) when the client supports it.
- The service folder `.mcp` is protected from changes through the tools.
- Deletion is reversible by default: the file goes to the trash.
- Archives are extracted inside the destination only; paths that try to
  escape it are rejected, ZIP64 and encrypted archives are not supported.
- The server never runs shell commands unless `MCP_ALLOW_SHELL=1` is set.
  When enabled, commands run with your user rights, are limited to the allowed
  folders, are logged to `.mcp/commands.log`, and are not covered by trash or
  undo. Background processes are capped and stopped when the server exits.
- **Sandbox (experimental):** with `MCP_SANDBOX=1` every `run_command` is
  isolated — **Windows:** an AppContainer (no network, writes only in the
  working folder, mapped to a temporary drive letter); **macOS:** a Seatbelt
  profile via `sandbox-exec` (no network, writes only in the working folder,
  the service folder and temp directories). Commands that need the internet
  or the user profile fail with access errors — that is the sandbox working.
  If the sandbox itself cannot start, a custom dialog asks whether to run
  the command outside it; the choice is logged. Background processes
  (`start_process`) are not sandboxed.
- The AI can also proactively request an unsandboxed run: it passes
  `sandbox=false` to `run_command`, and a native dialog (WinForms on
  Windows, NSAlert on macOS) shows the exact command in a black frame for
  you to allow or decline. Declined commands are never executed; both the
  request and the choice are logged.
- The UI listens on `127.0.0.1` only and requires a random token in the URL,
  so other devices and websites cannot control it.

If you need access to the whole disk, set `MCP_ALLOW_OUTSIDE_ROOT=1`. Do this
consciously: Claude will be able to change any file your user has rights to.

## Development

```powershell
npm test
```

Runs a cross-platform smoke test against a real server instance (28 tools,
read guards, undo, zip, PDF, notebooks, resources, elicitation). The same test
runs on macOS, Linux and Windows in CI on every push.

```powershell
npm run inspect
```

Starts MCP Inspector for manual testing of the tools.

## License

MIT
