// Ambient declaration so standalone `tsc --noEmit` resolves global CSS
// side-effect imports (e.g. `import "./globals.css"`) without depending on
// Next's generated next-env.d.ts. Next's bundler handles the actual loading.
declare module "*.css";
