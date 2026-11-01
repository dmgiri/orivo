using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Anvaya Setup")]
[assembly: AssemblyProduct("Anvaya")]
[assembly: AssemblyDescription("Windows per-user installer for Anvaya")]
[assembly: AssemblyVersion("__ASSEMBLY_VERSION__")]
[assembly: AssemblyFileVersion("__ASSEMBLY_VERSION__")]

namespace AnvayaInstaller
{
    internal static class Program
    {
        internal const string Product = "Anvaya";
        internal const string Version = "__PACKAGE_VERSION__";
        internal const string RegistryKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Anvaya";
        internal const string UninstallerName = "Uninstall-Anvaya.ps1";
        private const string PayloadResource = "AnvayaPayload.zip";
        private const string UninstallerResource = "AnvayaUninstaller.ps1";

        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                if (args.Length == 2 && String.Equals(args[0], "--verify-payload", StringComparison.OrdinalIgnoreCase))
                {
                    ExtractAndVerify(args[1], null);
                    return 0;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new SetupForm());
                return 0;
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, "Anvaya Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        internal static string DefaultInstallDirectory()
        {
            string existing = RegisteredInstallDirectory();
            if (!String.IsNullOrWhiteSpace(existing)) return existing;
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", Product);
        }

        internal static string RegisteredInstallDirectory()
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RegistryKeyPath))
                return key == null ? null : key.GetValue("InstallLocation") as string;
        }

        internal static ReleaseManifest ReadManifest(string path)
        {
            using (FileStream input = File.OpenRead(path))
            {
                DataContractJsonSerializer serializer = new DataContractJsonSerializer(typeof(ReleaseManifest));
                return serializer.ReadObject(input) as ReleaseManifest;
            }
        }

        internal static string SafeEntryPath(string root, string archivePath)
        {
            if (String.IsNullOrWhiteSpace(archivePath) || Path.IsPathRooted(archivePath) || archivePath.IndexOf(':') >= 0)
                throw new InvalidDataException("The installer contains an invalid file path.");
            string relative = archivePath.Replace('/', Path.DirectorySeparatorChar).Replace('\\', Path.DirectorySeparatorChar);
            string fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string fullPath = Path.GetFullPath(Path.Combine(fullRoot, relative));
            if (!fullPath.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("The installer contains a path outside the install folder.");
            return fullPath;
        }

        internal static void ExtractAndVerify(string destination, IProgress<InstallProgress> progress)
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            using (Stream embedded = assembly.GetManifestResourceStream(PayloadResource))
            {
                if (embedded == null) throw new InvalidDataException("The setup file is missing its application payload.");
                using (ZipArchive archive = new ZipArchive(embedded, ZipArchiveMode.Read, false))
                {
                    long totalBytes = 0;
                    foreach (ZipArchiveEntry entry in archive.Entries) totalBytes += entry.Length;
                    long copiedBytes = 0;
                    byte[] buffer = new byte[1024 * 256];
                    DateTime lastReport = DateTime.MinValue;
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        string target = SafeEntryPath(destination, entry.FullName);
                        int unixFileType = (entry.ExternalAttributes >> 16) & 0xF000;
                        if (unixFileType == 0xA000) throw new InvalidDataException("The installer contains a symbolic link and cannot be installed safely.");
                        if (entry.FullName.EndsWith("/", StringComparison.Ordinal) || entry.FullName.EndsWith("\\", StringComparison.Ordinal))
                        {
                            Directory.CreateDirectory(target);
                            continue;
                        }
                        string parent = Path.GetDirectoryName(target);
                        if (!String.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                        using (Stream input = entry.Open())
                        using (FileStream output = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None))
                        {
                            int read;
                            while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                            {
                                output.Write(buffer, 0, read);
                                copiedBytes += read;
                                if (progress != null && (DateTime.UtcNow - lastReport).TotalMilliseconds > 120)
                                {
                                    progress.Report(new InstallProgress("Installing Anvaya…", Percent(copiedBytes, totalBytes)));
                                    Application.DoEvents();
                                    lastReport = DateTime.UtcNow;
                                }
                            }
                        }
                    }
                }
            }

            string manifestPath = Path.Combine(destination, "release-manifest.json");
            if (!File.Exists(manifestPath)) throw new InvalidDataException("The setup payload is incomplete: release manifest not found.");
            ReleaseManifest manifest = ReadManifest(manifestPath);
            if (manifest == null || !String.Equals(manifest.product, Product, StringComparison.Ordinal) ||
                !String.Equals(manifest.version, Version, StringComparison.Ordinal) || manifest.files == null)
                throw new InvalidDataException("The setup payload does not match this Anvaya release.");

            int verified = 0;
            foreach (ReleaseFile file in manifest.files)
            {
                string path = SafeEntryPath(destination, file.path);
                FileInfo info = new FileInfo(path);
                if (!info.Exists || info.Length != file.bytes)
                    throw new InvalidDataException("An application file is missing or has the wrong size: " + file.path);
                using (SHA256 sha = SHA256.Create())
                using (FileStream input = info.OpenRead())
                {
                    string actual = BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
                    if (!String.Equals(actual, file.sha256, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("An application file failed its integrity check: " + file.path);
                }
                verified++;
                if (progress != null && (verified % 20 == 0 || verified == manifest.files.Count))
                {
                    progress.Report(new InstallProgress("Verifying application files…", 92 + (8 * verified / manifest.files.Count)));
                    Application.DoEvents();
                }
            }

            if (!File.Exists(Path.Combine(destination, "Anvaya.exe")))
                throw new InvalidDataException("The setup payload does not contain Anvaya.exe.");
            if (progress != null) progress.Report(new InstallProgress("Preparing the uninstaller…", 99));
            using (Stream source = assembly.GetManifestResourceStream(UninstallerResource))
            {
                if (source == null) throw new InvalidDataException("The setup file is missing its uninstaller.");
                using (FileStream output = File.Create(Path.Combine(destination, UninstallerName))) source.CopyTo(output);
            }
        }

        private static int Percent(long current, long total)
        {
            if (total <= 0) return 0;
            return (int)Math.Min(90, current * 90 / total);
        }

        internal static void CreateShortcut(string shortcutPath, string targetPath)
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) throw new InvalidOperationException("Windows could not create the Anvaya shortcut.");
            object shell = Activator.CreateInstance(shellType);
            object shortcut = null;
            try
            {
                shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { shortcutPath });
                Type type = shortcut.GetType();
                type.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { targetPath });
                type.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { Path.GetDirectoryName(targetPath) });
                type.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { targetPath + ",0" });
                type.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { "Trace application data with Anvaya" });
                type.InvokeMember("WindowStyle", BindingFlags.SetProperty, null, shortcut, new object[] { 1 });
                type.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            }
            finally
            {
                if (shortcut != null && Marshal.IsComObject(shortcut)) Marshal.FinalReleaseComObject(shortcut);
                if (Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
            }
        }

        internal static bool IsApplicationDirectory(string directory)
        {
            string manifest = Path.Combine(directory, "release-manifest.json");
            if (!File.Exists(manifest)) return false;
            try
            {
                ReleaseManifest value = ReadManifest(manifest);
                return value != null && String.Equals(value.product, Product, StringComparison.Ordinal);
            }
            catch { return false; }
        }
    }

    internal sealed class SetupForm : Form
    {
        private readonly TextBox location;
        private readonly CheckBox startMenu;
        private readonly CheckBox desktop;
        private readonly CheckBox launch;
        private readonly Button install;
        private readonly Button cancel;
        private readonly ProgressBar progress;
        private readonly Label status;
        private bool busy;
        private bool installed;
        private string installedPath;

        internal SetupForm()
        {
            Text = "Anvaya Setup";
            Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = true;
            ClientSize = new Size(690, 470);
            BackColor = Color.FromArgb(245, 247, 250);
            Font = new Font("Segoe UI", 9F);
            FormClosing += delegate(object sender, FormClosingEventArgs args) { if (busy) args.Cancel = true; };

            Panel accent = new Panel { Dock = DockStyle.Top, Height = 6, BackColor = Color.FromArgb(53, 143, 255) };
            Controls.Add(accent);
            Label title = new Label { Text = "Install Anvaya", Font = new Font("Segoe UI", 20F, FontStyle.Bold), ForeColor = Color.FromArgb(25, 35, 50), Location = new Point(30, 28), AutoSize = true };
            Controls.Add(title);
            Label subtitle = new Label { Text = "Windows desktop · " + Program.Version + " beta", ForeColor = Color.FromArgb(90, 103, 119), Location = new Point(32, 70), AutoSize = true };
            Controls.Add(subtitle);
            Label description = new Label { Text = "Install Anvaya for your Windows account. No administrator access is needed.", ForeColor = Color.FromArgb(60, 72, 88), Location = new Point(32, 111), AutoSize = true };
            Controls.Add(description);

            Label pathLabel = new Label { Text = "Install location", Location = new Point(32, 164), AutoSize = true, Font = new Font("Segoe UI", 9F, FontStyle.Bold) };
            Controls.Add(pathLabel);
            location = new TextBox { Location = new Point(32, 190), Size = new Size(510, 28), Text = Program.DefaultInstallDirectory(), Font = new Font("Consolas", 9F) };
            Controls.Add(location);
            Button browse = new Button { Text = "Browse…", Location = new Point(552, 188), Size = new Size(105, 31) };
            browse.Click += BrowseClick;
            Controls.Add(browse);

            startMenu = new CheckBox { Text = "Create a Start Menu shortcut", Checked = true, Location = new Point(32, 244), AutoSize = true };
            desktop = new CheckBox { Text = "Create a desktop shortcut", Checked = false, Location = new Point(32, 276), AutoSize = true };
            launch = new CheckBox { Text = "Launch Anvaya when setup finishes", Checked = true, Location = new Point(32, 308), AutoSize = true };
            Controls.Add(startMenu);
            Controls.Add(desktop);
            Controls.Add(launch);

            Label dataNote = new Label { Text = "Your Anvaya settings stay in your Windows profile and are kept when you uninstall.", ForeColor = Color.FromArgb(90, 103, 119), Location = new Point(32, 355), AutoSize = true };
            Controls.Add(dataNote);
            progress = new ProgressBar { Location = new Point(32, 395), Size = new Size(625, 13), Visible = false, Style = ProgressBarStyle.Continuous };
            status = new Label { Text = "", Location = new Point(32, 374), AutoSize = true, ForeColor = Color.FromArgb(70, 84, 101), Visible = false };
            Controls.Add(status);
            Controls.Add(progress);

            install = new Button { Text = "Install", Location = new Point(442, 422), Size = new Size(102, 32), BackColor = Color.FromArgb(39, 114, 226), ForeColor = Color.White, FlatStyle = FlatStyle.Flat, Font = new Font("Segoe UI", 9F, FontStyle.Bold) };
            install.FlatAppearance.BorderSize = 0;
            install.Click += InstallClick;
            cancel = new Button { Text = "Cancel", Location = new Point(555, 422), Size = new Size(102, 32) };
            cancel.Click += delegate { if (!busy) Close(); };
            Controls.Add(install);
            Controls.Add(cancel);
            AcceptButton = install;
            CancelButton = cancel;
        }

        private void BrowseClick(object sender, EventArgs e)
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "Choose the Anvaya installation folder.";
                string current = location.Text.Trim();
                if (Directory.Exists(current)) dialog.SelectedPath = current;
                else if (Directory.Exists(Path.GetDirectoryName(current))) dialog.SelectedPath = Path.GetDirectoryName(current);
                if (dialog.ShowDialog(this) == DialogResult.OK) location.Text = dialog.SelectedPath;
            }
        }

        private void InstallClick(object sender, EventArgs e)
        {
            if (installed)
            {
                if (launch.Checked) Process.Start(new ProcessStartInfo(Path.Combine(installedPath, "Anvaya.exe")) { WorkingDirectory = installedPath });
                Close();
                return;
            }
            string target;
            try { target = ValidateDestination(location.Text); }
            catch (Exception ex) { MessageBox.Show(this, ex.Message, "Choose an install location", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }

            string registered = Program.RegisteredInstallDirectory();
            if (!String.IsNullOrWhiteSpace(registered) && !String.Equals(Path.GetFullPath(registered).TrimEnd(Path.DirectorySeparatorChar), target, StringComparison.OrdinalIgnoreCase))
            {
                MessageBox.Show(this, "Anvaya is already installed in a different folder. Use the existing location to update it, or uninstall Anvaya before moving it.", "Existing installation", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            if (IsRunning(target))
            {
                MessageBox.Show(this, "Close Anvaya before installing or updating it.", "Anvaya is running", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            busy = true;
            SetInputsEnabled(false);
            progress.Visible = true;
            status.Visible = true;
            status.Text = "Preparing installation…";
            string stage = Path.Combine(Path.GetDirectoryName(target), ".Anvaya-installing-" + Guid.NewGuid().ToString("N"));
            string backup = Path.Combine(Path.GetDirectoryName(target), ".Anvaya-backup-" + Guid.NewGuid().ToString("N"));
            bool movedOld = false;
            bool movedNew = false;
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                Directory.CreateDirectory(stage);
                Program.ExtractAndVerify(stage, new FormProgress(this));
                status.Text = "Finishing setup…";
                Application.DoEvents();

                if (Directory.Exists(target))
                {
                    Directory.Move(target, backup);
                    movedOld = true;
                }
                Directory.Move(stage, target);
                movedNew = true;

                try
                {
                    ConfigureShortcutsAndUninstall(target);
                }
                catch
                {
                    if (movedNew && Directory.Exists(target)) Directory.Delete(target, true);
                    if (movedOld && Directory.Exists(backup)) Directory.Move(backup, target);
                    throw;
                }

                if (movedOld && Directory.Exists(backup)) Directory.Delete(backup, true);
                installed = true;
                installedPath = target;
                progress.Value = 100;
                status.Text = "Anvaya is installed.";
                install.Text = launch.Checked ? "Finish and launch" : "Finish";
                cancel.Text = "Close";
                launch.Enabled = true;
                install.Enabled = true;
                cancel.Enabled = true;
                busy = false;
            }
            catch (Exception ex)
            {
                try { if (Directory.Exists(stage)) Directory.Delete(stage, true); } catch { }
                try
                {
                    if (movedNew && Directory.Exists(target)) Directory.Delete(target, true);
                    if (movedOld && Directory.Exists(backup) && !Directory.Exists(target)) Directory.Move(backup, target);
                }
                catch { }
                MessageBox.Show(this, "Anvaya could not be installed. " + ex.Message, "Setup failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
                SetInputsEnabled(true);
                progress.Visible = false;
                status.Visible = false;
                busy = false;
            }
        }

        private string ValidateDestination(string text)
        {
            if (String.IsNullOrWhiteSpace(text)) throw new ArgumentException("Choose an installation folder.");
            string target = Path.GetFullPath(Environment.ExpandEnvironmentVariables(text.Trim())).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string drive = Path.GetPathRoot(target).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (target.Length == 0 || String.Equals(target, drive, StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Choose a folder inside a drive, not the drive root.");
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData).TrimEnd(Path.DirectorySeparatorChar);
            string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows).TrimEnd(Path.DirectorySeparatorChar);
            string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile).TrimEnd(Path.DirectorySeparatorChar);
            if (String.Equals(target, localAppData, StringComparison.OrdinalIgnoreCase) ||
                String.Equals(target, windows, StringComparison.OrdinalIgnoreCase) ||
                String.Equals(target, profile, StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Choose a dedicated folder for Anvaya.");
            if (Directory.Exists(target) && !Program.IsApplicationDirectory(target))
            {
                if (Directory.GetFileSystemEntries(target).Length > 0)
                    throw new ArgumentException("That folder already contains other files. Choose an empty folder or the existing Anvaya installation.");
            }
            return target;
        }

        private bool IsRunning(string target)
        {
            foreach (Process process in Process.GetProcessesByName("Anvaya"))
            {
                try
                {
                    if (String.Equals(Path.GetDirectoryName(process.MainModule.FileName), target, StringComparison.OrdinalIgnoreCase)) return true;
                }
                catch { }
                finally { process.Dispose(); }
            }
            return false;
        }

        private void ConfigureShortcutsAndUninstall(string target)
        {
            string menu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Anvaya");
            string menuLink = Path.Combine(menu, "Anvaya.lnk");
            string desktopLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Anvaya.lnk");
            if (startMenu.Checked)
            {
                Directory.CreateDirectory(menu);
                Program.CreateShortcut(menuLink, Path.Combine(target, "Anvaya.exe"));
            }
            else if (File.Exists(menuLink)) File.Delete(menuLink);
            if (desktop.Checked) Program.CreateShortcut(desktopLink, Path.Combine(target, "Anvaya.exe"));
            else if (File.Exists(desktopLink)) File.Delete(desktopLink);

            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(Program.RegistryKeyPath))
            {
                if (key == null) throw new InvalidOperationException("Windows could not register the Anvaya uninstaller.");
                key.SetValue("DisplayName", "Anvaya");
                key.SetValue("DisplayVersion", Program.Version);
                key.SetValue("InstallLocation", target);
                key.SetValue("DisplayIcon", Path.Combine(target, "Anvaya.exe"));
                key.SetValue("UninstallString", "powershell.exe -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File \"" + Path.Combine(target, Program.UninstallerName) + "\"");
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
            }
        }

        private void SetInputsEnabled(bool value)
        {
            location.Enabled = value;
            startMenu.Enabled = value;
            desktop.Enabled = value;
            launch.Enabled = value;
            install.Enabled = value;
            cancel.Enabled = value;
        }

        private sealed class FormProgress : IProgress<InstallProgress>
        {
            private readonly SetupForm form;
            internal FormProgress(SetupForm owner) { form = owner; }
            public void Report(InstallProgress value)
            {
                form.status.Text = value.Message;
                form.progress.Value = Math.Max(0, Math.Min(100, value.Percent));
            }
        }
    }

    internal sealed class InstallProgress
    {
        internal readonly string Message;
        internal readonly int Percent;
        internal InstallProgress(string message, int percent) { Message = message; Percent = percent; }
    }

    [DataContract]
    internal sealed class ReleaseManifest
    {
        [DataMember(Name = "product")] public string product { get; set; }
        [DataMember(Name = "version")] public string version { get; set; }
        [DataMember(Name = "files")] public List<ReleaseFile> files { get; set; }
    }

    [DataContract]
    internal sealed class ReleaseFile
    {
        [DataMember(Name = "path")] public string path { get; set; }
        [DataMember(Name = "bytes")] public long bytes { get; set; }
        [DataMember(Name = "sha256")] public string sha256 { get; set; }
    }
}
