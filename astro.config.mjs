import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://listips.com',
  output: 'static',
  compressHTML: true,
  trailingSlash: 'always'
});
