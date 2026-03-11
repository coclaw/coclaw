<template>
	<!--
		⚠️ 布局关键约束 ⚠️
		- 原生壳：AuthedLayout 已约束视口高度，此处用 flex-1+min-h-0 填充剩余空间
		- Web：父容器仅 min-height，需 h-dvh 硬约束以固定 header/footer（临时方案，
		  后续全面改为浏览器滚动后可移除 h-dvh）
		- 勿同时加 flex-1 + h-dvh，否则 flex 算法以 max-content 撑开父容器
	-->
	<div data-testid="chat-root" class="relative flex flex-col overflow-hidden" :class="chatRootClasses">
		<MobilePageHeader :title="chatTitle">
			<template v-if="chatStore.isMainSession" #actions>
				<UButton
					data-testid="btn-new-chat"
					class="cc-icon-btn-lg"
					variant="ghost"
					color="primary"
					icon="i-lucide-square-pen"
					:loading="chatStore.resetting"
					@click="onNewChat"
				/>
			</template>
		</MobilePageHeader>
		<header class="z-10 hidden shrink-0 min-h-12 items-center border-b border-default bg-elevated pl-4 py-1 md:flex">
			<h1 class="text-base --font-medium">{{ chatTitle }}</h1>
			<div class="ml-auto pr-2">
				<UButton
					v-if="chatStore.isMainSession"
					data-testid="btn-new-chat"
					class="cc-icon-btn"
					variant="ghost"
					color="primary"
					icon="i-lucide-square-pen"
					:loading="chatStore.resetting"
					@click="onNewChat"
				/>
			</div>
		</header>

		<!-- flex-1 + min-h-0：让 main 填充剩余空间并内部滚动；移除 min-h-0 会导致撑开父容器 -->
		<main ref="scrollContainer" class="flex-1 min-h-0 overflow-x-hidden overflow-y-auto" @scroll="onScroll">
			<div class="mx-auto w-full max-w-3xl">
				<div v-if="isBotOffline" class="mx-4 mt-4 rounded-lg bg-warning/10 px-4 py-2 text-center text-sm text-warning">
					{{ $t('chat.botOffline') }}
				</div>
				<div v-if="chatStore.loading" class="px-4 py-8 text-center text-sm text-muted">
					{{ $t('chat.loading') }}
				</div>
				<div v-else-if="chatStore.errorText && !isBotOffline" class="px-4 py-8 text-center text-sm text-error">
					{{ chatStore.errorText }}
				</div>
				<div v-else-if="chatMessages.length > 0" class="pb-2">
					<ChatMsgItem
						v-for="item in chatMessages"
						:key="item.id"
						:item="item"
					/>
				</div>
				<div v-else class="px-4 py-8 text-center text-sm text-toned">
					{{ $t('chat.empty') }}
				</div>
			</div>
		</main>

		<ChatInput
			ref="chatInput"
			v-model="inputText"
			:sending="chatStore.sending"
			:disabled="!currentSessionId || isBotOffline"
			@send="onSendMessage"
			@cancel="onCancelSend"
		/>
	</div>
</template>

<script>
import MobilePageHeader from '../components/MobilePageHeader.vue';
import ChatMsgItem from '../components/ChatMsgItem.vue';
import ChatInput from '../components/ChatInput.vue';
import { useNotify } from '../composables/use-notify.js';
import { useBotsStore } from '../stores/bots.store.js';
import { useSessionsStore } from '../stores/sessions.store.js';
import { useChatStore } from '../stores/chat.store.js';
import { groupSessionMessages, cleanDerivedTitle } from '../utils/session-msg-group.js';
import { isNative } from '../utils/capacitor-app.js';

export default {
	name: 'ChatPage',
	components: {
		MobilePageHeader,
		ChatMsgItem,
		ChatInput,
	},
	setup() {
		return {
			notify: useNotify(),
			chatStore: useChatStore(),
		};
	},
	data() {
		return {
			inputText: '',
			userScrolledUp: false,
		};
	},
	computed: {
		chatRootClasses() {
			return isNative ? 'flex-1 min-h-0' : 'h-dvh';
		},
		currentSessionId() {
			return typeof this.$route.params?.sessionId === 'string'
				? this.$route.params.sessionId.trim()
				: '';
		},
		isBotOffline() {
			const botId = this.chatStore.botId;
			if (!botId) return false;
			const bot = useBotsStore().items.find((b) => String(b.id) === String(botId));
			return bot ? !bot.online : true;
		},
		chatTitle() {
			if (!this.currentSessionId) return '';
			const session = useSessionsStore().items.find(
				(s) => s.sessionId === this.currentSessionId,
			);
			if (session) {
				const label = (typeof session.title === 'string' && session.title.trim())
					? cleanDerivedTitle(session.title) || session.title.trim()
					: cleanDerivedTitle(session.derivedTitle);
				if (label) return label;
			}
			return this.$t('chat.sessionTitle', { id: this.currentSessionId });
		},
		detailRoutePrefix() {
			return this.$route.path.startsWith('/topics/') ? '/topics' : '/home';
		},
		chatMessages() {
			return groupSessionMessages(this.chatStore.messages);
		},
	},
	async mounted() {
		await this.chatStore.activateSession(this.currentSessionId);
	},
	watch: {
		'$route.params.sessionId': {
			handler(newId) {
				this.chatStore.activateSession(typeof newId === 'string' ? newId.trim() : '');
			},
		},
		isBotOffline(offline) {
			if (offline) {
				this.chatStore.cancelSend();
			}
			else {
				this.chatStore.loadMessages();
			}
		},
		// bot 被解绑且从列表中消失：通知并跳转
		'chatStore.botId'(newVal, oldVal) {
			if (oldVal && !newVal && this.currentSessionId) {
				const botStillExists = useBotsStore().items.some(
					(b) => String(b.id) === String(oldVal),
				);
				if (botStillExists) return;
				this.chatStore.cleanup();
				this.notify.warning(this.$t('chat.botUnbound'));
				this.$router.replace(this.detailRoutePrefix === '/topics' ? '/topics' : '/');
			}
		},
		'chatStore.messages.length'() {
			this.scrollToBottom();
		},
	},
	beforeUnmount() {
		this.chatStore.cleanup();
	},
	methods: {
		async onSendMessage({ text, files }) {
			if ((!text && !files?.length) || !this.currentSessionId || this.chatStore.sending) {
				return;
			}
			const savedText = this.inputText;
			this.inputText = '';
			this.userScrolledUp = false;
			this.scrollToBottom();

			try {
				const result = await this.chatStore.sendMessage(text, files);
				if (!result.accepted) {
					this.inputText = savedText;
					this.$refs.chatInput?.restoreFiles(files);
				}
			}
			catch (err) {
				this.notify.error(err?.message || this.$t('chat.orphanSendFailed'));
				if (!this.chatStore.__accepted) {
					this.inputText = savedText;
					this.$refs.chatInput?.restoreFiles(files);
				}
			}
		},
		async onNewChat() {
			try {
				const newSessionId = await this.chatStore.resetChat();
				if (newSessionId) {
					this.$router.push({ name: 'chat', params: { sessionId: newSessionId } });
				}
			}
			catch (err) {
				console.error('[chat] onNewChat error:', err);
				this.notify.error(this.$t('chat.newChatFailed'));
			}
		},
		onCancelSend() {
			this.chatStore.cancelSend();
		},
		scrollToBottom() {
			const el = this.$refs.scrollContainer;
			if (el?.scrollTo && !this.userScrolledUp) {
				this.$nextTick(() => {
					el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
				});
			}
		},
		onScroll() {
			const el = this.$refs.scrollContainer;
			if (!el) return;
			const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
			this.userScrolledUp = !atBottom;
		},
	},
};
</script>
