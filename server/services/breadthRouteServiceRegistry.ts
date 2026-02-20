import type { BreadthRouteService } from './BreadthRouteService.js';

let breadthRouteServiceInstance: BreadthRouteService | null = null;

export function setBreadthRouteServiceInstance(service: BreadthRouteService): void {
  breadthRouteServiceInstance = service;
}

export function getBreadthRouteServiceInstance(): BreadthRouteService | null {
  return breadthRouteServiceInstance;
}
