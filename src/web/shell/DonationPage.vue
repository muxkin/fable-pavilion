<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import SvgIcon from '../SvgIcon.vue';
import './donation.css';

interface SupportPlatform {
  name: string;
  creator?: string;
  url?: string;
  enabled: boolean;
}
interface WechatReward {
  recipient: string;
  qr: string;
  previewCrop?: { x: number; y: number; size: number };
}
interface SupportConfig {
  platform?: SupportPlatform;
  wechat?: WechatReward;
  github?: string | false;
}
const defaultGithubRepo = (() => {
  const configured =
    typeof __POCKET_RELEASE_REPO__ === 'string'
      ? __POCKET_RELEASE_REPO__.trim()
      : 'https://github.com/muxkin/fable-pavilion';
  if (!configured || configured.toLowerCase() === 'none') return undefined;
  return configured.replace(/\/+$/, '');
})();
function safeURL(value: unknown, image = false): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return;
  try {
    const url = image ? new URL(value, location.origin) : new URL(value);
    if (url.username || url.password) return;
    if (image) {
      if (url.origin === location.origin && ['http:', 'https:'].includes(url.protocol)) return url.href;
    } else if (url.protocol === 'https:') return url.href;
  } catch {
    /* Never expose an invalid public configuration as a payment link. */
  }
}
function parseConfig(value: any): SupportConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
  const config: SupportConfig = {},
    p = value.platform,
    w = value.wechat;
  if (p && typeof p.name === 'string' && p.name.trim()) {
    const url = safeURL(p.url);
    config.platform = {
      name: p.name.trim().slice(0, 40),
      creator: typeof p.creator === 'string' ? p.creator.trim().slice(0, 80) : undefined,
      url,
      enabled: p.enabled === true && !!url,
    };
  }
  const qr = safeURL(w?.qr, true);
  if (qr && typeof w.recipient === 'string' && w.recipient.trim()) {
    const c = w.previewCrop;
    const crop =
      c &&
      [c.x, c.y, c.size].every(Number.isFinite) &&
      c.x >= 0 &&
      c.y >= 0 &&
      c.size >= 0.25 &&
      c.size <= 1 &&
      c.x + c.size <= 1 &&
      c.y + c.size <= 1
        ? { x: c.x, y: c.y, size: c.size }
        : undefined;
    config.wechat = { qr, recipient: w.recipient.trim().slice(0, 80), previewCrop: crop };
  }
  if (value.github === false) {
    config.github = false;
  } else if (typeof value.github === 'string') {
    const repo = safeURL(value.github);
    if (repo) config.github = repo.replace(/\/+$/, '');
  }
  return config;
}
const config = shallowRef<SupportConfig>({});
const state = ref<'loading' | 'ready' | 'error'>('loading');
const revision = ref(0);
const imageError = ref(false);
const imageRevision = ref(0);
const platform = computed(() => config.value.platform);
const wechat = computed(() => config.value.wechat);
const githubRepo = computed(() => {
  if (config.value.github === false) return undefined;
  return config.value.github ?? defaultGithubRepo;
});
const githubSlug = computed(() => {
  const repo = githubRepo.value;
  if (!repo) return '';
  try {
    return new URL(repo).pathname.replace(/^\/+|\/+$/g, '');
  } catch {
    return '';
  }
});
const crop = computed(() => wechat.value?.previewCrop);
const imageStyle = computed(() => {
  const area = crop.value;
  if (!area) return;
  return {
    width: `${100 / area.size}%`,
    left: `${(-100 * area.x) / area.size}%`,
    top: `${(-100 * area.y) / area.size}%`,
  };
});
const imageURL = computed(() => {
  const qr = wechat.value?.qr;
  if (!qr || !imageRevision.value) return qr;
  return qr + `${qr.includes('?') ? '&' : '?'}retry=${imageRevision.value}`;
});

watch(
  revision,
  async (_revision, _previous, onCleanup) => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    state.value = 'loading';
    try {
      const response = await fetch('/support.json', { cache: 'no-cache', signal: controller.signal });
      if (!response.ok) throw Error();
      const next = parseConfig(await response.json());
      if (controller.signal.aborted) return;
      config.value = next;
      imageError.value = false;
      state.value = 'ready';
    } catch {
      if (!controller.signal.aborted) state.value = 'error';
    }
  },
  { immediate: true },
);

function retryImage() {
  imageError.value = false;
  imageRevision.value++;
}
</script>

<template>
  <div class="support-page">
    <section class="support-intro">
      <span class="support-heart">
        <SvgIcon name="heart" :size="25" />
      </span>
      <h2>支持子虚亭</h2>
      <p>如果它让你与 AI 的交流更轻松，<br />欢迎随心支持，让项目继续成长。</p>
    </section>
    <p v-if="state === 'loading'" class="support-notice" role="status">正在加载支持方式…</p>
    <div v-else-if="state === 'error'" class="support-notice" role="status">
      <p>支持方式暂时无法加载。</p>
      <button class="secondary" @click="revision++">重试</button>
    </div>
    <template v-else>
      <section v-if="wechat" class="reward-card" aria-labelledby="wechat-reward-title">
        <div class="reward-heading">
          <h3 id="wechat-reward-title">微信赞赏</h3>
          <span>随心支持</span>
        </div>
        <div v-if="imageError" class="reward-image-error" role="status">
          <SvgIcon name="heart" :size="28" />
          <p>赞赏码暂时无法加载</p>
          <button class="secondary" @click="retryImage">重新加载赞赏码</button>
        </div>
        <div v-else class="reward-code">
          <span class="reward-code-frame">
            <img
              :src="imageURL"
              :alt="`${wechat.recipient}的微信赞赏码`"
              :style="imageStyle"
              class="reward-code-image"
              :class="{ cropped: crop }"
              @error="imageError = true"
            />
          </span>
        </div>
        <p class="reward-recipient">{{ wechat.recipient }}的赞赏码</p>
        <p v-if="!imageError" class="reward-help">长按图片保存，再在微信扫一扫中<br />从相册选择。</p>
      </section>
      <template v-if="platform">
        <a
          v-if="platform.enabled"
          class="support-platform-card"
          :href="platform.url"
          target="_blank"
          rel="noopener noreferrer"
          :aria-label="`前往${platform.name}（新窗口）`"
        >
          <span class="support-platform-icon">
            <SvgIcon name="heart" :size="23" />
          </span>
          <span class="support-platform-text">
            <strong>在{{ platform.name }}支持</strong>
            <small>{{ platform.creator ? `${platform.creator} · ` : '' }}查看创作与赞助方案</small>
          </span>
          <SvgIcon name="arrow" :size="20" />
        </a>
        <div v-else class="support-notice" role="status">{{ platform.name }}主页正在准备中。</div>
      </template>
      <p v-if="!wechat && !platform && !githubRepo" class="support-notice" role="status">
        支持方式正在准备中，谢谢你的心意。
      </p>
    </template>
    <section v-if="githubRepo" class="support-github-card" aria-labelledby="support-github-title">
      <div class="support-github-head">
        <span class="support-platform-icon">
          <SvgIcon name="github" :size="22" />
        </span>
        <div class="support-platform-text">
          <strong id="support-github-title">开源共建 · GitHub</strong>
          <small>{{ githubSlug || '访问开源仓库，一起打磨子虚亭' }}</small>
        </div>
        <a
          class="support-github-repo-link"
          :href="githubRepo"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="打开 GitHub 仓库（新窗口）"
        >
          <span>仓库主页</span>
          <SvgIcon name="external" :size="14" />
        </a>
      </div>
      <div class="support-github-actions">
        <a
          class="support-github-action"
          :href="githubRepo"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="前往 GitHub 为项目点 Star（新窗口）"
        >
          <span class="support-github-action-icon">
            <SvgIcon name="star" :size="18" />
          </span>
          <strong>点个 Star</strong>
          <small>收藏项目，关注更新</small>
        </a>
        <a
          class="support-github-action"
          :href="`${githubRepo}/issues/new/choose`"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="前往 GitHub 提交 Issue（新窗口）"
        >
          <span class="support-github-action-icon">
            <SvgIcon name="info" :size="18" />
          </span>
          <strong>提交 Issue</strong>
          <small>反馈问题或提出建议</small>
        </a>
        <a
          class="support-github-action"
          :href="`${githubRepo}/pulls`"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="前往 GitHub 参与贡献加入项目（新窗口）"
        >
          <span class="support-github-action-icon">
            <SvgIcon name="branch" :size="18" />
          </span>
          <strong>加入项目</strong>
          <small>贡献代码、插件或文档</small>
        </a>
      </div>
    </section>
    <section class="support-purpose">
      <h3>每一份支持，都用在持续改进上</h3>
      <p>改进跨端体验与适配器，支持开发、测试和服务维护。</p>
      <div>
        <span><SvgIcon name="monitor" :size="17" /> 跨端体验</span>
        <span><SvgIcon name="code" :size="17" /> 持续开发</span>
        <span><SvgIcon name="shield" :size="17" /> 服务维护</span>
      </div>
    </section>
    <p class="support-footnote">
      支持完全自愿，不改变现有功能或账户额度。<br />反馈和分享，同样是对项目的支持。
    </p>
  </div>
</template>
