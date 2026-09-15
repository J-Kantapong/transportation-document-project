import type { CSSProperties } from "react";

// The prototype's CSS reads custom properties like --c/--bg for icon and progress-bar
// colors; @types/react's CSSProperties doesn't declare arbitrary custom properties.
export type CSSVarStyle = CSSProperties & Record<`--${string}`, string | number | undefined>;
