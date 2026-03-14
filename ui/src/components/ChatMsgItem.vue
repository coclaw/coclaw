<template>
	<div class="px-3 py-3 sm:px-4 sm:py-4 lg:px-5">
		<!-- user 消息 -->
		<template v-if="isUser">
			<div class="flex flex-col items-end">
				<div class="max-w-[85%] rounded-2xl bg-primary px-3 py-2 text-base leading-relaxed text-white whitespace-pre-wrap">
					{{ item.textContent }}
					<img
						v-for="(img, i) in item.images"
						:key="i"
						:src="imgSrc(img)"
						class="mt-1 max-w-full rounded-lg"
					/>
				</div>
				<div class="mt-1.5 flex items-center gap-1 text-xs text-dimmed">
					<span v-if="formattedTime">{{ formattedTime }}</span>
					<UButton
						class="cc-icon-btn"
						:icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
						variant="ghost"
						color="neutral"
						size="md"
						@click="copyText(item.textContent)"
					/>
				</div>
			</div>
		</template>

		<!-- botTask 消息 -->
		<template v-else>
			<!-- 头像 + 思考/折叠行 -->
			<div class="mb-2 flex items-center gap-2">
				<span
					v-if="botEmoji && !agentDisplay?.avatarUrl"
					class="size-6 shrink-0 rounded-sm bg-accented flex items-center justify-center text-sm leading-none"
				>{{ botEmoji }}</span>
				<img
					v-else
					:src="botAvatarUrl"
					alt="bot"
					class="size-6 rounded-sm object-cover"
				/>
				<!-- 流式中 + 有步骤 → 可展开 + 实时计时 -->
				<button
					v-if="item.isStreaming && item.steps.length"
					class="flex items-center gap-1 text-sm text-dimmed hover:text-muted"
					@click="stepsExpanded = !stepsExpanded"
				>
					<span>{{ streamingThinkingLabel }}</span>
					<UIcon
						:name="stepsExpanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
						class="size-3.5"
					/>
				</button>
				<!-- 流式中 + 无步骤 → 纯文字 + 三点动画 -->
				<span v-else-if="item.isStreaming" class="text-sm text-dimmed">
					<span class="cc-thinking-dots">{{ streamingThinkingLabel }}</span>
				</span>
				<!-- 非流式：折叠行 -->
				<button
					v-else
					class="flex items-center gap-1 text-sm text-dimmed hover:text-muted"
					@click="stepsExpanded = !stepsExpanded"
				>
					<span>{{ thinkingLabel }}</span>
					<UIcon
						:name="stepsExpanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
						class="size-3.5"
					/>
				</button>
			</div>

			<!-- 展开的思考过程 -->
			<div
				v-if="stepsExpanded && item.steps.length"
				class="mb-2 space-y-2 border-l-2 border-default pl-4"
			>
				<div
					v-for="(step, idx) in item.steps"
					:key="idx"
					class="text-sm leading-relaxed"
				>
					<!-- thinking -->
					<div v-if="step.kind === 'thinking'" class="text-dimmed">
						{{ step.text }}
					</div>
					<!-- toolCall -->
					<div v-else-if="step.kind === 'toolCall'">
						<span class="inline-block rounded bg-muted/60 px-1.5 py-0.5 text-xs font-medium text-toned">
							{{ $t('chat.toolCallLabel', { name: step.name }) }}
						</span>
					</div>
					<!-- toolResult -->
					<div
						v-else-if="step.kind === 'toolResult'"
						class="max-h-32 overflow-auto text-dimmed"
					>
						{{ step.text }}
					</div>
					<!-- image -->
					<img
						v-else-if="step.kind === 'image'"
						:src="imgSrc(step)"
						class="max-h-32 rounded"
					/>
				</div>
			</div>

			<!-- 正文区图像 -->
			<img
				v-for="(img, i) in item.images"
				:key="'img-' + i"
				:src="imgSrc(img)"
				class="mb-2 max-w-full rounded-lg"
			/>

			<!-- 最终结果（流式中且无文本时不渲染） -->
			<template v-if="item.isStreaming && !item.resultText">
				<!-- 等待首段文本，不渲染占位 -->
			</template>
			<MarkdownBody v-else-if="item.resultText" :text="item.resultText" />
			<div v-else class="text-base text-dimmed italic">
				{{ $t('chat.taskIncomplete') }}
			</div>

			<!-- 底部元信息（流式中隐藏） -->
			<div v-if="!item.isStreaming" class="mt-2 flex items-center text-xs leading-relaxed text-dimmed">
				<div class="flex items-center gap-2">
					<span v-if="formattedTime">{{ formattedTime }}</span>
					<span v-if="item.model">{{ item.model }}</span>
				</div>
				<UButton
					class="cc-icon-btn ml-auto"
					:icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
					variant="ghost"
					color="neutral"
					size="md"
					@click="copyText(item.resultText)"
				/>
			</div>
		</template>
	</div>
</template>

<script>
import MarkdownBody from './MarkdownBody.vue';
import botAvatarSvg from '../assets/bot-avatars/openclaw.svg';
import { useNotify } from '../composables/use-notify.js';

export default {
	name: 'ChatMsgItem',
	components: { MarkdownBody },
	props: {
		item: {
			type: Object,
			required: true,
		},
		agentDisplay: {
			type: Object,
			default: () => ({ name: 'Agent', avatarUrl: null, emoji: null }),
		},
	},
	setup() {
		return { notify: useNotify() };
	},
	data() {
		return {
			stepsExpanded: false,
			copied: false,
			streamingElapsed: 0,
			__elapsedTimer: null,
		};
	},
	computed: {
		isUser() {
			return this.item.type === 'user';
		},
		botAvatarUrl() {
			return this.agentDisplay?.avatarUrl || botAvatarSvg;
		},
		botEmoji() {
			return this.agentDisplay?.emoji || null;
		},
		formattedTime() {
			const ts = this.item.timestamp;
			if (!ts) return '';
			const d = new Date(ts);
			if (isNaN(d.getTime())) return '';
			const hh = String(d.getHours()).padStart(2, '0');
			const mm = String(d.getMinutes()).padStart(2, '0');
			return `${hh}:${mm}`;
		},
		thinkingLabel() {
			const dur = this.item.duration;
			if (!dur || dur < 1000) {
				return this.$t('chat.thought');
			}
			return this.$t('chat.thoughtFor', { time: this.formatDuration(dur) });
		},
		streamingThinkingLabel() {
			if (this.streamingElapsed < 1000) {
				return this.$t('chat.botThinking');
			}
			return this.$t('chat.thinkingFor', { time: this.formatDuration(this.streamingElapsed) });
		},
	},
	watch: {
		'item.isStreaming': {
			immediate: true,
			handler(val) {
				this.__stopElapsedTimer();
				if (val && this.item.startTime) {
					this.streamingElapsed = Date.now() - this.item.startTime;
					this.__elapsedTimer = setInterval(() => {
						this.streamingElapsed = Date.now() - this.item.startTime;
					}, 1000);
				} else {
					this.streamingElapsed = 0;
				}
			},
		},
	},
	beforeUnmount() {
		this.__stopElapsedTimer();
	},
	methods: {
		__stopElapsedTimer() {
			if (this.__elapsedTimer) {
				clearInterval(this.__elapsedTimer);
				this.__elapsedTimer = null;
			}
		},
		imgSrc(img) {
			return `data:${img.mimeType};base64,${img.data}`;
		},
		copyText(text) {
			if (!text) return;
			navigator.clipboard.writeText(text).then(() => {
				this.copied = true;
				setTimeout(() => {
					this.copied = false;
				}, 2000);
			}).catch(() => {
				this.notify.error(this.$t('common.copyFailed'));
			});
		},
		formatDuration(ms) {
			const totalSec = Math.floor(ms / 1000);
			if (totalSec < 60) {
				return this.$t('chat.durationSec', { s: totalSec });
			}
			const hours = Math.floor(totalSec / 3600);
			const mins = Math.floor((totalSec % 3600) / 60);
			const secs = totalSec % 60;
			if (hours > 0) {
				return this.$t('chat.durationHourMin', { h: hours, m: mins });
			}
			return this.$t('chat.durationMinSec', { m: mins, s: secs });
		},
	},
};
</script>

<style scoped>
.cc-thinking-dots::after {
	content: '';
	animation: cc-dots 1.2s steps(4, end) infinite;
}
@keyframes cc-dots {
	0% { content: ''; }
	25% { content: '.'; }
	50% { content: '..'; }
	75% { content: '...'; }
}
</style>
