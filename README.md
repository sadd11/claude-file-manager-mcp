# Claude File Manager MCP

An MCP server for Claude that can create, read, edit, copy, move and delete
files and folders — and, optionally, run terminal commands.

It runs locally over `stdio`, without internet access or third-party services.

## Features

| Tool               | What it does                                             |
| ------------------ | -------------------------------------------------------- |
| `list_directory`   | Lists folder contents (optionally recursive)             |
| `read_file`        | Reads a text file, optionally a line range               |
| `write_file`       | Creates or overwrites a file                             |
| `append_file`      | Appends text to the end of a file                        |
| `edit_file`        | Replaces an exact fragment and shows a diff              |
| `multi_edit`       | Several replacements in one call, atomically             |
| `create_directory` | Creates a folder with all missing parents                |
| `move_path`        | Moves or renames a file/folder                           |
| `copy_path`        | Copies a file or folder                                  |
| `delete_path`      | Moves to trash (or permanently with `permanent=true`)    |
| `file_info`        | Shows type, size and dates of a file/folder              |
| `find_files`       | Finds files by glob or name substring                    |
| `search_content`   | Searches text/regex inside files                         |
| `list_trash`       | Shows the trash                                          |
| `restore_path`     | Restores a file/folder from the trash                    |
| `undo_last_change` | Undoes the last change (up to 20 steps)                  |
| `run_command`      | Runs a terminal command (optional, off by default)       |

The terminal tool is disabled unless `MCP_ALLOW_SHELL=1` is set. All other
tools work with files only.

## Windows installation (prebuilt installer)

Download **[ClaudeFileManager-Setup-1.2.0.exe](https://github.com/sadd11/claude-file-manager-mcp/releases/latest)**.

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

**Portable version:** **[ClaudeFileManager-Portable-1.2.0.zip](https://github.com/sadd11/claude-file-manager-mcp/releases/latest)** —
extract anywhere and run `start-ui.cmd`. No installation required.

### Building the installer

```powershell
winget install --id JRSoftware.InnoSetup -e
npm run build:installer
```

The output appears in `installer\out`. The script copies the Node runtime,
installs production dependencies, draws the icon and builds both the `.exe`
and the portable `.zip`.

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
3. Click **Connect to Claude Desktop**.
4. Fully close and reopen Claude Desktop.

The UI also provides:

- **Check server** — actually starts the MCP server and lists the working
  tools;
- a "Connected to Claude Desktop" indicator that shows which folder is used;
- a list of recent folders;
- an **Open** button that reveals the selected folder in Explorer;
- an "Allow terminal commands" switch (see below);
- the JSON config and a ready-made Claude Code command.

The UI creates (or carefully updates) `%APPDATA%\Claude\claude_desktop_config.json`,
saves a backup, and shows the JSON config and Claude Code command if you prefer
to connect manually.

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
> Add `"MCP_ALLOW_SHELL": "1"` to `env` to enable the optional terminal tool.

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

- `delete_path` by default **does not destroy** the file; it moves it to the
  trash. Restore it with `restore_path` or `undo_last_change`.
- `edit_file`, `multi_edit`, `write_file` and `append_file` save a copy of the
  old version before modifying.
- `undo_last_change` reverts the last action; several steps can be undone.
- Permanent deletion happens only with `permanent=true`.

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

The terminal is **not a sandbox**. Commands run with your user rights and
every side effect is real — `rm`, `git reset --hard` and similar commands do
what they say, and the file tools' trash and undo do not cover them. Leave
the switch off unless you need it, and read a command before you approve it.

## Example prompts

- "Find all `*.tsx` files in `src`."
- "Find where `MCP_FILE_ROOT` is used and show the lines."
- "In `config.js` replace `port: 3000` with `port: 8080` and `debug: false`
  with `debug: true` — do it in one action."
- "Delete `temp.log`." → the file goes to the trash.
- "Run `npm test` and show me the failures." (terminal enabled)
- "Run `git status` in this folder." (terminal enabled)
- "Restore the last deletion." / "Undo the last two changes."
- "Show the trash."
- "Create `docs/api.md` and describe the endpoints from `src/routes`."

## Settings (environment variables)

| Variable                 | Default            | Description                                          |
| ------------------------ | ------------------ | ---------------------------------------------------- |
| `MCP_FILE_ROOT`          | current directory  | Root folder inside which operations are allowed      |
| `MCP_ALLOW_OUTSIDE_ROOT` | `0`                | `1` — allow arbitrary paths (use with care!)         |
| `MCP_ALLOW_SHELL`        | `0`                | `1` — register the `run_command` terminal tool       |
| `MCP_SHELL`              | `powershell` / `sh`| Shell used by `run_command` (`cmd`, `pwsh`, `bash`)  |
| `MCP_MAX_OUTPUT_CHARS`   | `200000`           | stdout/stderr capture limit per command              |
| `MCP_MAX_READ_CHARS`     | `400000`           | Character limit when reading a file                  |
| `MCP_MAX_LIST_ENTRIES`   | `5000`             | Entry limit when listing                             |
| `MCP_DATA_DIR`           | `<root>/.mcp`      | Where to store trash, backups and history            |
| `UI_PORT`                | `4317`             | Local UI port (`npm run ui`)                         |
| `UI_NO_OPEN`             | —                  | `1` — do not open the browser automatically          |

## Security

- All paths are normalized; escaping `MCP_FILE_ROOT` is blocked.
- The root folder cannot be deleted, moved or overwritten.
- A non-empty folder can only be deleted with `recursive=true`.
- Overwriting or copying onto an existing file requires `overwrite=true`.
- The service folder `.mcp` is protected from changes through the tools.
- Deletion is reversible by default: the file goes to the trash.
- The server never runs shell commands unless `MCP_ALLOW_SHELL=1` is set.
  When enabled, commands run with your user rights, are limited to the chosen
  folder, are logged to `.mcp/commands.log`, and are not covered by trash or
  undo.
- The UI listens on `127.0.0.1` only and requires a random token in the URL,
  so other devices and websites cannot control it.

If you need access to the whole disk, set `MCP_ALLOW_OUTSIDE_ROOT=1`. Do this
consciously: Claude will be able to change any file your user has rights to.

## Development

```powershell
npm run inspect
```

Starts MCP Inspector for manual testing of the tools.

## License

MIT
