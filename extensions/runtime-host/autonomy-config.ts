import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Atomic config toggle; refuses malformed input and preserves every unrelated field. */
export function setAutonomyEnabled(on: boolean, configPath: string): { ok: boolean; error?: string } {
	let raw: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "invalid config object" };
		raw = parsed as Record<string, unknown>;
	} catch (e) { return { ok: false, error: `config read failed: ${e instanceof Error ? e.message : String(e)}` }; }
	const autonomy = raw.autonomy && typeof raw.autonomy === "object" && !Array.isArray(raw.autonomy)
		? raw.autonomy as Record<string, unknown> : {};
	raw.autonomy = { ...autonomy, enabled: on };
	const tmp = join(dirname(configPath), `.${process.pid}.${Math.random().toString(36).slice(2)}.autonomy.tmp`);
	try { writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { flag: "wx" }); renameSync(tmp, configPath); return { ok: true }; }
	catch (e) { try { unlinkSync(tmp); } catch { /* ignore */ } return { ok: false, error: `config write failed: ${e instanceof Error ? e.message : String(e)}` }; }
}
