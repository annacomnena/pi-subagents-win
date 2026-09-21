// cn = clsx + tailwind-merge（zcode packages/ui/src/lib/utils.ts 原样移植；
// text-ui-* 是字号而不是 text color，显式注册进 font-size 组避免互相覆盖）。
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const mergeUiClasses = extendTailwindMerge({
	extend: {
		classGroups: {
			"font-size": [
				"text-ui-xl",
				"text-ui-lg",
				"text-ui-base",
				"text-ui-caption",
				"text-ui-sm",
				"text-ui-xs",
				"text-ui-2xs",
			],
		},
	},
});

export function cn(...inputs: ClassValue[]) {
	return mergeUiClasses(clsx(inputs));
}
