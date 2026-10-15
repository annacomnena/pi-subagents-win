/**
 * AppearancePage.tsx — 「外观」设置页（S6：主题偏好）。
 *
 * 纯 UI 态：偏好写 localStorage（键 `od-gui-theme`），**不写 config.json、
 * 不加后端端点、不动 daemon**（指导文档 §2 C-3 红线）。
 *
 * 默认暖暗（风格指南口径「暖暗优先」，工作台长时间盯屏）；暖亮为结构免费的次选。
 * 两档均已通过 §6 对比度硬门（正文/元信息/徽章 ≥4.5:1、大字与图标 ≥3:1）。
 */

import { Check } from "lucide-react";
import { Card, PageIntro, Term } from "../ui";
import { THEME_LABEL, type GuiTheme } from "../theme";
import { useTheme } from "../useTheme";

const OPTIONS: { id: GuiTheme; zh: string; desc: string }[] = [
	{
		id: "warm-dark",
		zh: "暖暗（默认）",
		desc: "暖炭底 #141413 + 暖灰字 + 陶土重音。长时间盯屏的默认档。",
	},
	{
		id: "warm-light",
		zh: "暖亮",
		desc: "羊皮纸底 #f5f4ed + 近黑字。日间/投影环境更易读。",
	},
];

/** 主题预览小色块（用语义 token，随主题自动变）。 */
function Swatch({ theme }: { theme: GuiTheme }) {
	// 预览块固定渲染两套主题的实际色，故直接挂对应 class（不依赖当前主题）
	return (
		<div className={`${theme === "warm-light" ? "theme-warm-light" : "theme-warm-dark"} flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1.5`}>
			<span className="size-3 rounded-full bg-background" />
			<span className="size-3 rounded-full bg-card" />
			<span className="size-3 rounded-full bg-accent" />
			<span className="text-ui-xs text-foreground-subtle">Aa</span>
		</div>
	);
}

export function AppearancePage() {
	const [theme, setTheme] = useTheme();

	return (
		<div className="space-y-3">
			<PageIntro>界面主题（只影响本浏览器，不写服务端配置）</PageIntro>
			<Card
				title={<Term zh="主题" en="theme" hint="偏好存 localStorage 键 od-gui-theme；默认暖暗；不写 config.json、不加后端端点" />}
			>
				<ul className="space-y-2">
					{OPTIONS.map((o) => {
						const active = theme === o.id;
						return (
							<li key={o.id}>
								<button
									type="button"
									onClick={() => setTheme(o.id)}
									aria-pressed={active}
									className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
										active ? "border-accent bg-selected" : "border-border hover:bg-hover"
									}`}								>
									<span className="flex size-4 shrink-0 items-center justify-center">
										{/* L4 复算修正：accent-text(coral) 在 selected 合成底上仅 4.36:1（不达）
										 * ⇒ 选中勾用 foreground（当前主题下 9.44:1） */}
										{active && <Check className="size-4 text-foreground" />}
									</span>
									<span className="min-w-0 flex-1">
										<span className="block text-ui-base text-foreground">{o.zh}</span>
										<span className="mt-0.5 block text-ui-sm text-foreground-subtle">{o.desc}</span>
									</span>
									<Swatch theme={o.id} />
								</button>
							</li>
						);
					})}
				</ul>
								<p className="mt-3 text-ui-sm text-foreground-subtle">
					当前：{THEME_LABEL[theme]}。两档均已过对比度硬门（正文/元信息 ≥4.5:1、大字与图标 ≥3:1）。
			</p>
			</Card>
		</div>
	);
}
