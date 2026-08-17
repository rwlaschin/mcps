<template>
  <div
    class="group relative overflow-clip rounded-[32px] border border-white/10 p-6
           backdrop-blur-xl transition-[border-color,backdrop-filter,transform] duration-300
           hover:border-white/20 hover:backdrop-blur-2xl hover:scale-[1.005]
           glass-panel"
  >
    <!-- Very light tint only – transparent so background specular shows through -->
    <div
      class="absolute inset-0 z-0 rounded-[32px] pointer-events-none bg-white/[0.02] group-hover:bg-white/[0.04] transition-colors duration-300 ease-out"
      aria-hidden="true"
    />
    <!-- Texture: noise (subtle) -->
    <div
      class="absolute inset-0 z-0 opacity-[0.02] mix-blend-soft-light pointer-events-none bg-noise rounded-[32px]"
      aria-hidden="true"
    />

    <div class="relative z-10">
      <slot />
    </div>
  </div>
</template>
