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

/** `badge()` returns the badge to draw, or undefined to draw nothing. */
export function leftBadgeEditor(badge: () => string | undefined) {
	let before: EditorFactory | undefined;
	let ours: EditorFactory | undefined;
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
				return editor;
			};
			ctx.ui.setEditorComponent(ours);
		},
		remove(ctx: ExtensionContext): void {
			if (!ours) return;
			// Only put the old editor back if nobody replaced ours in the meantime.
			if (ctx.mode === "tui" && ctx.ui.getEditorComponent() === ours) ctx.ui.setEditorComponent(before);
			ours = before = undefined;
		},
	};
}
