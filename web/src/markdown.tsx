/**
 * Legacy surface, now a shell over ui/Markdown.tsx, which holds the renderer and its styles.
 * The component is a pure function of its `source` and never interprets HTML, so nothing else
 * about this module changed.
 */
export { Markdown } from "./ui";
