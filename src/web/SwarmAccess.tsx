import { computed, defineComponent, inject, provide, toRef, type InjectionKey, type Ref } from 'vue';

export type SwarmTab = 'board' | 'members' | 'overview';

export interface SwarmOpenOptions {
  tab?: SwarmTab;
  member?: string;
}

export interface SwarmAccess {
  openSwarm(options?: SwarmOpenOptions): void;
}

const swarmAccessKey: InjectionKey<Readonly<Ref<SwarmAccess | null>>> = Symbol('swarm-access');

export const SwarmAccessProvider = defineComponent(
  (props: { value: SwarmAccess | null }, { slots }) => {
    provide(
      swarmAccessKey,
      toRef(() => props.value),
    );
    return () => slots.default?.();
  },
  { props: ['value'] },
);

export function useSwarmAccess() {
  return inject(swarmAccessKey, () => computed(() => null), true);
}
