/**
 * Left-side badge on the input box's top border (HARDcode / SoftCode), mirroring
 * UltraCode's ⚡ultracode on the right. It wraps whatever editor is installed and
 * restores it on remove.
 */

import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

/**
 * Overlay the badge on the leading run of border characters of the editor's top line,
 * keeping the visible width exact (pi-tui aborts on over-wide lines).
 */
export function withLeftBadge(line: string, badge: string): string {
	const run = visibleWidth(badge) + 2;
	const m = new RegExp(`^((?:\\x1b\\[[0-9;]*m)*)(─{${run}})`).exec(line);
	if (!m) return line;
	const borderColor = m[1] ?? "";
	return `${borderColor}─${badge}${borderColor}─${line.slice(m[0].length)}`;
}

/**
 * `badge()` returns the badge to draw, or undefined to draw nothing. `thinkingLevel()` is the
 * session's current level: when an editor is swapped in, pi copies the border colour from its
 * hidden default editor, which is stale if the thinking level changed while another editor was
 * showing, so we recolour the new editor ourselves.
 */
export function leftBadgeEditor(badge: () => string | undefined, thinkingLevel: () => string) {
	let before: EditorFactory | undefined;
	let ours: EditorFactory | undefined;
	let created: any;

	/** Swap in `factory` and give the editor it creates the border colour for the current thinking level. */
	function swap(ctx: ExtensionContext, factory: EditorFactory): void {
		created = undefined;
		ctx.ui.setEditorComponent(factory);
		try {
			if (created && "borderColor" in created) created.borderColor = ctx.ui.theme.getThinkingBorderColor((thinkingLevel() || "off") as any);
		} catch {}
		created = undefined;
	}

	return {
		install(ctx: ExtensionContext): void {
			if (ctx.mode !== "tui" || ours) return;
			const inner = ctx.ui.getEditorComponent();
			before = inner;
			ours = (tui, theme, keybindings) => {
				const editor = inner ? inner(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
				const render = editor.render.bind(editor);
				editor.render = (width: number) => {
					const lines = render(width);
					const b = badge();
					if (!b || !lines.length) return lines;
					const out = [...lines];
					out[0] = withLeftBadge(out[0]!, b);
					return out;
				};
				created = editor;
				return editor;
			};
			swap(ctx, ours);
		},
		remove(ctx: ExtensionContext): void {
			if (!ours) return;
			// Only put the old editor back if nobody replaced ours in the meantime.
			if (ctx.mode === "tui" && ctx.ui.getEditorComponent() === ours) {
				const inner = before;
				// Re-wrapped only to reach the new instance for its colour; with no previous custom editor, pi's own default comes back.
				if (inner) swap(ctx, (tui, theme, keybindings) => (created = inner(tui, theme, keybindings)));
				else ctx.ui.setEditorComponent(undefined);
			}
			ours = before = undefined;
		},
	};
}
