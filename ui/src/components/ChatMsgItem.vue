<template>
	<div class="px-3 py-3 sm:px-4 sm:py-4 lg:px-5">
		<!-- user 消息 -->
		<template v-if="isUser">
			<div class="flex flex-col items-end">
				<!-- 文本气泡 + inline 图片 -->
				<div
					v-if="item.textContent || item.images?.length"
					class="max-w-[85%] rounded-2xl bg-primary px-3 py-2 text-base leading-relaxed text-white whitespace-pre-wrap break-words"
				>
					<template v-if="item.textContent">{{ item.textContent }}</template>
					<ChatImg
						v-for="(img, i) in item.images"
						:key="i"
						:src="imgSrc(img)"
						:filename="imgFilename(img, i)"
						custom-class="mt-1 max-w-full"
					/>
				</div>
				<!-- 附件（非图片 + 未 inline 的图片） -->
				<div
					v-if="userAttachments.length"
					class="mt-1.5 flex max-w-[85%] flex-wrap justify-end gap-1.5"
				>
					<template v-for="(att, idx) in userAttachments" :key="'att-' + idx">
						<!-- 语音附件 -->
						<ChatAudio
							v-if="att.isVoice"
							:src="att.url"
							:duration-ms="att.durationMs"
						/>
						<!-- 普通文件附件卡片 -->
						<div
							v-else
							class="flex items-center gap-2 rounded-lg border border-default bg-elevated px-3 py-2 text-xs"
						>
							<UIcon :name="att.isImg ? 'i-lucide-image' : 'i-lucide-file'" class="text-base text-muted shrink-0" />
							<div class="min-w-0">
								<div class="truncate font-medium text-default max-w-32">{{ attDisplayName(att) }}</div>
								<div class="text-muted">{{ att.size }}</div>
							</div>
						</div>
					</template>
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
					<ChatImg
						v-else-if="step.kind === 'image'"
						:src="imgSrc(step)"
						:filename="imgFilename(step, idx)"
						custom-class="max-h-32"
					/>
				</div>
			</div>

			<!-- 正文区图像 -->
			<ChatImg
				v-for="(img, i) in item.images"
				:key="'img-' + i"
				:src="imgSrc(img)"
				:filename="imgFilename(img, i)"
				custom-class="mb-2 max-w-full"
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
					@click="copyBotResult"
				/>
			</div>
		</template>
	</div>
</template>

<script>
import MarkdownBody from './MarkdownBody.vue';
import ChatImg from './ChatImg.vue';
import ChatAudio from './ChatAudio.vue';
import botAvatarSvg from '../assets/bot-avatars/openclaw.svg';
import { formatFileSize } from '../utils/file-helper.js';
import { buildCoclawUrl } from '../services/coclaw-file.js';
import { useNotify } from '../composables/use-notify.js';

export default {
	name: 'ChatMsgItem',
	components: { MarkdownBody, ChatImg, ChatAudio },
	props: {
		item: {
			type: Object,
			required: true,
		},
		agentDisplay: {
			type: Object,
			default: () => ({ name: 'Agent', avatarUrl: null, emoji: null }),
		},
		botId: {
			type: String,
			default: '',
		},
		agentId: {
			type: String,
			default: '',
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
		/** 用户消息中需要以卡片形式展示的附件 */
		userAttachments() {
			const atts = this.item.attachments;
			if (!atts?.length) return [];
			// 附件信息来源于 parseAttachmentBlock（有 path/size/name/isImg/isVoice）
			// 或乐观消息的 _attachments（有 name/size/type/isVoice/durationMs/url）
			return atts.map((a) => {
				const result = {
					...a,
					size: typeof a.size === 'number' ? formatFileSize(a.size) : (a.size || ''),
				};
				// 语音附件：乐观消息已有 blob URL；历史消息需构建 coclaw-file URL
				if (a.isVoice && !a.url && a.path && this.botId && this.agentId) {
					result.url = buildCoclawUrl(this.botId, this.agentId, a.path);
				}
				return result;
			});
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
		/** 附件卡片显示名称：优先原始文件名，fallback 从 path 取 */
		attDisplayName(att) {
			if (att.name) return att.name;
			if (att.path) return att.path.split('/').pop();
			return 'file';
		},
		imgSrc(img) {
			return `data:${img.mimeType};base64,${img.data}`;
		},
		imgFilename(img, idx) {
			const ext = img.mimeType?.split('/')[1] || 'png';
			return `image-${idx + 1}.${ext}`;
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
		// 从渲染后的 DOM 取纯文本，避免复制原始 Markdown 符号（如 blockquote 的 >）
		copyBotResult() {
			const mdEl = this.$el?.querySelector('.cc-markdown');
			const text = mdEl?.innerText || this.item.resultText;
			this.copyText(text);
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
