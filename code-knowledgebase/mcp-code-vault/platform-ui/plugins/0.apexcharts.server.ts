/**
 * SSR stub for apexchart (runs first so Vue can resolve <apexchart> during server render).
 * The real component is registered in apexcharts.client.ts.
 */
export default defineNuxtPlugin((nuxtApp) => {
  const stub = {
    name: 'ApexchartStub',
    template: '<div class="apexchart-ssr-stub" style="min-height: 200px;" />'
  }
  nuxtApp.vueApp.component('apexchart', stub)
  nuxtApp.vueApp.component('ApexCharts', stub)
})
