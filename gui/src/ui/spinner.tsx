// zcode components/ui/spinner.tsx 原样移植；剥离点：useZCodeIntl → 写死中文 aria-label
//（拍板 4：ui 14 件零后端/i18n 依赖）。
import type * as React from "react";
import { LoaderIcon } from "lucide-react";

import { cn } from "./lib/utils";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
	return (
		<LoaderIcon
			role="status"
			aria-label="加载中"
			className={cn("size-4 animate-spin", className)}
			{...props}
		/>
	);
}

export { Spinner };
