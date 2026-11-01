using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Windows.Forms;

internal static class OrivoSetup
{
    private const string ProductName = "Orivo";

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 2 && args[0] == "--verify-payload")
            {
                var verificationDirectory = Path.GetFullPath(args[1]);
                ExtractPayload(verificationDirectory);
                WriteUninstaller(verificationDirectory);
                return 0;
            }

            var installDirectory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                ProductName);

            var result = MessageBox.Show(
                "Install Orivo for the current Windows user?\n\n" +
                "Location: " + installDirectory + "\n\n" +
                "Close Orivo before continuing.",
                "Install Orivo __PACKAGE_VERSION__",
                MessageBoxButtons.OKCancel,
                MessageBoxIcon.Information);
            if (result != DialogResult.OK) return 0;

            if (Directory.Exists(installDirectory)) Directory.Delete(installDirectory, true);
            ExtractPayload(installDirectory);
            WriteUninstaller(installDirectory);
            CreateShortcuts(installDirectory);

            MessageBox.Show(
                "Orivo was installed successfully.\n\n" +
                "Use the Start menu shortcut to launch it.",
                "Orivo installed",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Orivo installation failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static void ExtractPayload(string destination)
    {
        var root = Path.GetFullPath(destination);
        var rootPrefix = root.EndsWith(Path.DirectorySeparatorChar.ToString()) ? root : root + Path.DirectorySeparatorChar;
        Directory.CreateDirectory(root);

        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("OrivoPayload.zip"))
        {
            if (stream == null) throw new InvalidOperationException("The installer payload is missing.");
            using (var archive = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                foreach (var entry in archive.Entries)
                {
                    var relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                    if (string.IsNullOrWhiteSpace(relative)) continue;
                    var target = Path.GetFullPath(Path.Combine(root, relative));
                    if (!target.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("The installer payload contains an unsafe path.");

                    if (entry.Name.Length == 0)
                    {
                        Directory.CreateDirectory(target);
                        continue;
                    }

                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    entry.ExtractToFile(target, true);
                }
            }
        }

        var executable = Path.Combine(root, "Orivo.exe");
        if (!File.Exists(executable)) throw new InvalidOperationException("The installer payload does not contain Orivo.exe.");
    }

    private static void WriteUninstaller(string installDirectory)
    {
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("OrivoUninstaller.ps1"))
        {
            if (stream == null) throw new InvalidOperationException("The uninstaller payload is missing.");
            using (var file = File.Create(Path.Combine(installDirectory, "Uninstall-Orivo.ps1"))) stream.CopyTo(file);
        }

        File.WriteAllText(
            Path.Combine(installDirectory, "Uninstall Orivo.cmd"),
            "@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0Uninstall-Orivo.ps1\"\r\n");
    }

    private static void CreateShortcuts(string installDirectory)
    {
        var startMenu = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.Programs),
            ProductName);
        Directory.CreateDirectory(startMenu);

        var shellType = Type.GetTypeFromProgID("WScript.Shell");
        if (shellType == null) throw new InvalidOperationException("Windows shortcut support is unavailable.");
        dynamic shell = Activator.CreateInstance(shellType);
        WriteShortcut(shell, Path.Combine(startMenu, "Orivo.lnk"), Path.Combine(installDirectory, "Orivo.exe"), installDirectory, "Launch Orivo");
        WriteShortcut(shell, Path.Combine(startMenu, "Uninstall Orivo.lnk"), Path.Combine(installDirectory, "Uninstall Orivo.cmd"), installDirectory, "Remove Orivo for this user");
    }

    private static void WriteShortcut(dynamic shell, string linkPath, string targetPath, string workingDirectory, string description)
    {
        dynamic shortcut = shell.CreateShortcut(linkPath);
        shortcut.TargetPath = targetPath;
        shortcut.WorkingDirectory = workingDirectory;
        shortcut.Description = description;
        shortcut.Save();
    }
}
