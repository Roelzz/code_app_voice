/// <reference types="vite/client" />

// 3D model files are registered as Vite assets (`assetsInclude` in
// vite.config.ts), so `import shoeUrl from "@/assets/shoe.glb"` yields the
// file's served URL. These declarations give those imports that type.

declare module "*.glb" {
  const url: string;
  export default url;
}

declare module "*.gltf" {
  const url: string;
  export default url;
}

declare module "*.obj" {
  const url: string;
  export default url;
}

declare module "*.stl" {
  const url: string;
  export default url;
}
