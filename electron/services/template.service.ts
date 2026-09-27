/**
 * Template rendering lives in shared/template.ts because it is pure and the renderer uses it
 * for the live preview. The main process always re-renders before sending.
 */
export * from '../../shared/template';
