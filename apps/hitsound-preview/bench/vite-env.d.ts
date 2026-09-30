/// <reference types="vite/client" />

declare module "*.osu?raw"
{
  const src: string;
  export default src;
}
