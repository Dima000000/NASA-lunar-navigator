import {defineConfig} from 'vite';
export default defineConfig({base:'./',publicDir:'public',optimizeDeps:{entries:['index.html']},build:{target:'es2022',outDir:'dist',assetsInlineLimit:0},server:{host:'127.0.0.1'}});
