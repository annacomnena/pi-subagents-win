/**
 * notify-windows — PowerShell-based Windows Toast 通知
 *
 * 零额外依赖，使用 Windows 10/11 内置的 WinRT ToastNotification API。
 * 非 Windows 平台静默跳过。
 *
 * 策略：
 * - 使用 Microsoft.Windows.Shell.RunDialog 作为 AppID（系统内置，无需注册）
 * - XML 以 PowerShell 单引号字符串内联传入，$ 不会展开
 * - 只需 XML 转义（&<>"'），无需 PS 变量转义
 */

import { execFile } from "node:child_process";

const IS_WINDOWS = process.platform === "win32";

/** 系统内置 AppID，免注册即可发送 Toast */
const SYSTEM_APP_ID = "Microsoft.Windows.Shell.RunDialog";

/** 对 XML 内容中的特殊字符转义 */
function escXml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export interface NotifyOptions {
	title: string;
	body: string;
	duration?: "short" | "long";
}

/**
 * 发送 Windows Toast 通知。
 * 使用内联 XML 字符串 + 系统 AppID，无需提前注册。
 */
export function sendWindowsToast(opts: NotifyOptions): void {
	if (!IS_WINDOWS) return;

	const { title, body, duration = "short" } = opts;

	// PowerShell 脚本：加载 WinRT 类型 → 构造 XML → 发送 Toast
	// XML 放在单引号字符串 '...' 中，$ 不会展开，只需 XML 转义
	const psScript = [
		"Add-Type -AssemblyName System.Runtime.WindowsRuntime",
		// WinRT 类型注册（> $null 抑制输出）
		"$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
		"$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]",
		// 构造 XML
		"$xml = [Windows.Data.Xml.Dom.XmlDocument]::New()",
		// XML 在单引号字符串中，$ 是字面量
		'$xml.LoadXml(\'<toast duration="' + escXml(duration) + '"><visual><binding template="ToastGeneric"><text>' +
			escXml(title) + "</text><text>" + escXml(body) +
			"</text></binding></visual></toast>')",
		// 发送 Toast
		'[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("' + SYSTEM_APP_ID + '").Show(' +
			"[Windows.UI.Notifications.ToastNotification]::New($xml))",
	].join("; ");

	execFile(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Command", psScript],
		{
			timeout: 15000,
			windowsHide: true,
		},
		(err) => {
			if (err && !err.killed) {
				console.error("[notify-windows] failed:", err.message);
			}
		},
	);
}
