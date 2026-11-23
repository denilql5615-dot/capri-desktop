param(
  [Parameter(Mandatory=$true)][string]$Exe,
  [Parameter(Mandatory=$true)][string]$WorkDir,
  [Parameter(Mandatory=$true)][string]$Output,
  [Parameter(Mandatory=$true)][string]$Nonce
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class ClaudeQuotaConsole {
    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public short X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public short Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ScreenInfo { public Point Size, Cursor; public ushort Attr; public Rect Window; public Point Max; }
    [StructLayout(LayoutKind.Explicit, Size = 20)]
    private struct Input {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(4)] public int Down;
        [FieldOffset(8)] public ushort Repeat;
        [FieldOffset(10)] public ushort Key;
        [FieldOffset(14)] public ushort Character;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr unused,
        uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll")]
    private static extern bool GetConsoleScreenBufferInfo(SafeFileHandle handle, out ScreenInfo info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern bool ReadConsoleOutputCharacter(SafeFileHandle handle, StringBuilder value,
        uint count, Point start, out uint read);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern bool WriteConsoleInput(SafeFileHandle handle, Input[] input, uint count, out uint written);

    public static string Read() {
        using (var console = CreateFile("CONOUT$", 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
            ScreenInfo info;
            if (!GetConsoleScreenBufferInfo(console, out info)) return "";
            var text = new StringBuilder();
            for (short row = info.Window.Top; row <= info.Window.Bottom; row++) {
                var line = new StringBuilder(info.Size.X);
                uint read;
                if (ReadConsoleOutputCharacter(console, line, (uint)info.Size.X, new Point { Y = row }, out read))
                    text.AppendLine(line.ToString().Trim());
            }
            return text.ToString();
        }
    }

    public static bool SendUsage() {
        using (var console = CreateFile("CONIN$", 0x40000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
            var keys = "/usage\r";
            var events = new Input[keys.Length * 2];
            for (int i = 0; i < keys.Length; i++) {
                var key = keys[i];
                var input = new Input { Type = 1, Down = 1, Repeat = 1, Character = key,
                    Key = key == '/' ? (ushort)0xBF : char.ToUpperInvariant(key) };
                events[i * 2] = input;
                input.Down = 0;
                events[i * 2 + 1] = input;
            }
            uint written;
            return WriteConsoleInput(console, events, (uint)events.Length, out written) && written == events.Length;
        }
    }
}
'@

# This is a classic console of its own, even when Electron was launched in Windows Terminal.
$env:WT_SESSION = $null
$env:TERM_PROGRAM = $null
$env:TERM = 'xterm-256color'
$env:COLORTERM = 'truecolor'
$claude = Start-Process -FilePath $Exe -ArgumentList '--setting-sources= --tools=' -WorkingDirectory $WorkDir -NoNewWindow -PassThru
try {
  $until = [DateTime]::UtcNow.AddSeconds(18)
  $sent = $false
  $status = 'no-console-content'
  while (!$claude.HasExited -and [DateTime]::UtcNow -lt $until) {
    $screen = [ClaudeQuotaConsole]::Read()
    if ($screen.Trim()) { $status = 'waiting-for-prompt' }
    if ($screen -match 'Quick safety check|I trust this folder') {
      $status = 'workspace-untrusted'
      break
    }
    if (!$sent -and $screen -match 'Claude Code v' -and $screen -match '(?m)^[>\u276f]') {
      $sent = [ClaudeQuotaConsole]::SendUsage()
    }
    if ($sent) { $status = 'waiting-for-usage' }
    if ($sent -and $screen -match '(?im)^Current session\s*$' -and $screen -match '(?im)^Current week \(all models\)\s*$') {
      $lines = $screen -split '\r?\n' | Where-Object { $_ -match '^Current |^Resets?\b|\d+% used' }
      [IO.File]::WriteAllLines($Output, [string[]](@($Nonce) + @($lines)), [Text.Encoding]::UTF8)
      return
    }
    Start-Sleep -Milliseconds 200
  }
  if ($claude.HasExited) { $status = 'cli-exit-' + $claude.ExitCode }
  [IO.File]::WriteAllLines($Output, [string[]]@($Nonce, $status), [Text.Encoding]::UTF8)
} finally {
  if (!$claude.HasExited) { Stop-Process -Id $claude.Id -ErrorAction SilentlyContinue }
}
