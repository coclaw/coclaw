<template>
	<div class="flex min-h-0 flex-1 flex-col">
		<MobilePageHeader :title="$t('agentConfig.title')" />

		<main class="flex-1 overflow-auto px-3 pt-4 pb-8 sm:px-4 lg:px-5">
			<section class="mx-auto w-full max-w-2xl">
				<h1 class="mb-4 hidden text-base font-medium md:block">{{ $t('agentConfig.title') }}</h1>

				<UTabs v-model="activeTab" :items="tabItems">
					<!-- 个性化 -->
					<template #personality>
						<div class="space-y-5 py-4">
							<!-- Agent SOUL -->
							<h3 class="text-sm font-medium text-dimmed">Agent</h3>
							<UFormField :label="$t('agentConfig.personality.agentName')">
								<UInput v-model="soul.name" class="w-full" />
							</UFormField>
							<UFormField :label="$t('agentConfig.personality.tone')">
								<URadioGroup v-model="soul.tone" :items="toneOptions" />
							</UFormField>
							<UFormField :label="$t('agentConfig.personality.skills')">
								<UTextarea v-model="soul.skills" :rows="3" class="w-full" />
							</UFormField>
							<UFormField :label="$t('agentConfig.personality.extra')">
								<UTextarea v-model="soul.extra" :rows="3" class="w-full" />
							</UFormField>

							<USeparator />

							<!-- USER -->
							<h3 class="text-sm font-medium text-dimmed">{{ $t('agentConfig.personality.userName') }}</h3>
							<UFormField :label="$t('agentConfig.personality.userName')">
								<UInput v-model="user.name" class="w-full" />
							</UFormField>
							<UFormField :label="$t('agentConfig.personality.lang')">
								<URadioGroup v-model="user.lang" :items="langOptions" />
							</UFormField>
							<UFormField :label="$t('agentConfig.personality.userExtra')">
								<UTextarea v-model="user.extra" :rows="3" class="w-full" />
							</UFormField>

							<UButton color="primary" :loading="saving" @click="savePersonality">
								{{ $t('agentConfig.personality.save') }}
							</UButton>
						</div>
					</template>

					<!-- 记忆 -->
					<template #memory>
						<div class="py-4">
							<p v-if="!memoryBlocks.length" class="text-sm text-dimmed">{{ $t('agentConfig.memory.empty') }}</p>
							<div v-for="(block, idx) in memoryBlocks" :key="idx" class="mb-3 rounded-lg border border-default p-3">
								<div class="flex items-start justify-between gap-2">
									<h4 class="text-sm font-medium">{{ block.title }}</h4>
									<UButton
										size="xs"
										color="error"
										variant="ghost"
										icon="i-lucide-trash-2"
										data-testid="delete-memory-btn"
										@click="confirmDeleteIdx = idx; deleteOpen = true"
									/>
								</div>
								<p class="mt-1 whitespace-pre-wrap text-sm text-toned">{{ block.content }}</p>
							</div>
						</div>

						<!-- 删除确认对话框 -->
						<UModal v-model:open="deleteOpen" :title="$t('agentConfig.memory.deleteConfirm')" :ui="promptUi">
							<template #body>
								<p class="text-sm text-muted">{{ $t('agentConfig.memory.deleteConfirm') }}</p>
							</template>
							<template #footer>
								<div class="flex w-full justify-end gap-2">
									<UButton variant="ghost" color="neutral" @click="deleteOpen = false">{{ $t('common.cancel') }}</UButton>
									<UButton color="error" @click="onConfirmDelete">{{ $t('common.confirm') }}</UButton>
								</div>
							</template>
						</UModal>
					</template>

					<!-- 技能 -->
					<template #skills>
						<div class="py-4">
							<p v-if="!skillsList.length" class="text-sm text-dimmed">{{ $t('agentConfig.skills.empty') }}</p>
							<div v-for="skill in skillsList" :key="skill.name" class="mb-2 rounded-lg border border-default p-3">
								<p class="text-sm font-medium">{{ skill.name }}</p>
								<div class="mt-1 flex flex-wrap gap-3 text-xs text-dimmed">
									<span>{{ $t('agentConfig.skills.version') }}: {{ skill.version ?? '—' }}</span>
									<span>{{ $t('agentConfig.skills.source') }}: {{ skill.source ?? '—' }}</span>
									<span>{{ $t('agentConfig.skills.status') }}: {{ skill.status ?? '—' }}</span>
								</div>
							</div>
						</div>
					</template>

					<!-- 工具 -->
					<template #tools>
						<div class="py-4">
							<p v-if="!toolGroups.length" class="text-sm text-dimmed">{{ $t('agentConfig.tools.empty') }}</p>
							<UAccordion v-if="toolGroups.length" :items="toolAccordionItems" collapsible>
								<template v-for="group in toolGroups" :key="group.name" #[`${group.name}-body`]>
									<div class="space-y-2 pl-2">
										<div v-for="tool in group.tools" :key="tool.name" class="text-sm">
											<p class="font-medium">{{ tool.name }}</p>
											<p v-if="tool.description" class="text-xs text-dimmed">{{ tool.description }}</p>
										</div>
									</div>
								</template>
							</UAccordion>
						</div>
					</template>
				</UTabs>
			</section>
		</main>
	</div>
</template>

<script>
import MobilePageHeader from '../components/MobilePageHeader.vue';
import { useBotConnections } from '../services/bot-connection-manager.js';
import { useNotify } from '../composables/use-notify.js';
import { promptModalUi } from '../constants/prompt-modal-ui.js';

// 解析 SOUL.md 模板
function parseSoulMd(text) {
	const result = { name: '', tone: '', skills: '', extra: '' };
	if (!text) return result;
	const nameMatch = text.match(/- 名字：(.+)/);
	if (nameMatch) result.name = nameMatch[1].trim();
	const toneMatch = text.match(/- 语气：(.+)/);
	if (toneMatch) result.tone = toneMatch[1].trim();
	const skillsMatch = text.match(/## 专长\n([\s\S]*?)(?=\n## |$)/);
	if (skillsMatch) result.skills = skillsMatch[1].trim();
	const extraMatch = text.match(/## 补充说明\n([\s\S]*?)$/);
	if (extraMatch) result.extra = extraMatch[1].trim();
	return result;
}

// 解析 USER.md 模板
function parseUserMd(text) {
	const result = { name: '', lang: '', extra: '' };
	if (!text) return result;
	const nameMatch = text.match(/- 称谓：(.+)/);
	if (nameMatch) result.name = nameMatch[1].trim();
	const langMatch = text.match(/- 语言偏好：(.+)/);
	if (langMatch) result.lang = langMatch[1].trim();
	const extraMatch = text.match(/## 补充\n([\s\S]*?)$/);
	if (extraMatch) result.extra = extraMatch[1].trim();
	return result;
}

// 序列化回 SOUL.md
function serializeSoulMd(soul) {
	let md = '## 身份\n';
	md += `- 名字：${soul.name}\n`;
	md += `- 语气：${soul.tone}\n`;
	md += '## 专长\n';
	md += `${soul.skills}\n`;
	md += '## 补充说明\n';
	md += soul.extra;
	return md;
}

// 序列化回 USER.md
function serializeUserMd(user) {
	let md = '## 关于我\n';
	md += `- 称谓：${user.name}\n`;
	md += `- 语言偏好：${user.lang}\n`;
	md += '## 补充\n';
	md += user.extra;
	return md;
}

// 解析 MEMORY.md 为块列表
function parseMemoryBlocks(text) {
	if (!text) return [];
	const blocks = [];
	const parts = text.split(/^## /m).filter(Boolean);
	for (const part of parts) {
		const nlIdx = part.indexOf('\n');
		if (nlIdx === -1) {
			blocks.push({ title: part.trim(), content: '' });
		}
		else {
			blocks.push({
				title: part.slice(0, nlIdx).trim(),
				content: part.slice(nlIdx + 1).trim(),
			});
		}
	}
	return blocks;
}

// 重新拼接 MEMORY.md
function serializeMemoryBlocks(blocks) {
	return blocks.map(b => `## ${b.title}\n${b.content}`).join('\n\n');
}

export { parseSoulMd, parseUserMd, parseMemoryBlocks, serializeMemoryBlocks };

export default {
	name: 'AgentConfigPage',
	components: { MobilePageHeader },
	setup() {
		return {
			connMgr: useBotConnections(),
			notify: useNotify(),
			promptUi: promptModalUi,
		};
	},
	data() {
		return {
			activeTab: 'personality',
			saving: false,
			deleteOpen: false,
			confirmDeleteIdx: -1,
			soul: { name: '', tone: '', skills: '', extra: '' },
			user: { name: '', lang: '', extra: '' },
			memoryRaw: '',
			skillsList: [],
			toolGroups: [],
		};
	},
	computed: {
		botId() {
			return this.$route.params.botId;
		},
		agentId() {
			return this.$route.params.agentId;
		},
		conn() {
			return this.connMgr.get(this.botId);
		},
		tabItems() {
			return [
				{ label: this.$t('agentConfig.tabs.personality'), value: 'personality', slot: 'personality' },
				{ label: this.$t('agentConfig.tabs.memory'), value: 'memory', slot: 'memory' },
				{ label: this.$t('agentConfig.tabs.skills'), value: 'skills', slot: 'skills' },
				{ label: this.$t('agentConfig.tabs.tools'), value: 'tools', slot: 'tools' },
			];
		},
		toneOptions() {
			return [
				{ label: this.$t('agentConfig.personality.tones.casual'), value: 'casual' },
				{ label: this.$t('agentConfig.personality.tones.professional'), value: 'professional' },
				{ label: this.$t('agentConfig.personality.tones.concise'), value: 'concise' },
				{ label: this.$t('agentConfig.personality.tones.humorous'), value: 'humorous' },
			];
		},
		langOptions() {
			return [
				{ label: this.$t('agentConfig.personality.langs.zh'), value: 'zh' },
				{ label: this.$t('agentConfig.personality.langs.en'), value: 'en' },
				{ label: this.$t('agentConfig.personality.langs.auto'), value: 'auto' },
			];
		},
		memoryBlocks() {
			return parseMemoryBlocks(this.memoryRaw);
		},
		toolAccordionItems() {
			return this.toolGroups.map(g => ({
				label: `${g.name} (${g.tools.length})`,
				value: g.name,
				slot: g.name,
			}));
		},
	},
	async mounted() {
		await this.loadData();
	},
	watch: {
		activeTab(tab) {
			if (tab === 'skills' && !this.skillsList.length) this.loadSkills();
			if (tab === 'tools' && !this.toolGroups.length) this.loadTools();
		},
	},
	methods: {
		async loadData() {
			await Promise.all([
				this.loadFile('SOUL.md', (text) => {
					this.soul = parseSoulMd(text);
				}),
				this.loadFile('USER.md', (text) => {
					this.user = parseUserMd(text);
				}),
				this.loadFile('MEMORY.md', (text) => {
					this.memoryRaw = text ?? '';
				}),
			]);
		},
		async loadFile(name, handler) {
			if (!this.conn) return;
			try {
				const res = await this.conn.request('agents.files.get', {
					agentId: this.agentId,
					name,
				});
				if (res?.missing) {
					handler('');
				}
				else {
					handler(res?.content ?? '');
				}
			}
			catch {
				handler('');
			}
		},
		async savePersonality() {
			if (!this.conn) return;
			this.saving = true;
			try {
				const soulMd = serializeSoulMd(this.soul);
				const userMd = serializeUserMd(this.user);
				await Promise.all([
					this.conn.request('agents.files.set', {
						agentId: this.agentId,
						name: 'SOUL.md',
						content: soulMd,
					}),
					this.conn.request('agents.files.set', {
						agentId: this.agentId,
						name: 'USER.md',
						content: userMd,
					}),
				]);
				this.notify.success(this.$t('agentConfig.personality.saveSuccess'));
			}
			catch (err) {
				this.notify.error(err?.message ?? this.$t('agentConfig.personality.saveFailed'));
			}
			finally {
				this.saving = false;
			}
		},
		async deleteMemoryBlock(idx) {
			if (!this.conn) return;
			const blocks = [...this.memoryBlocks];
			blocks.splice(idx, 1);
			const newContent = serializeMemoryBlocks(blocks);
			try {
				await this.conn.request('agents.files.set', {
					agentId: this.agentId,
					name: 'MEMORY.md',
					content: newContent,
				});
				this.memoryRaw = newContent;
			}
			catch (err) {
				this.notify.error(err?.message ?? this.$t('agentConfig.memory.deleteFailed'));
			}
		},
		onConfirmDelete() {
			this.deleteOpen = false;
			if (this.confirmDeleteIdx >= 0) {
				this.deleteMemoryBlock(this.confirmDeleteIdx);
			}
		},
		async loadSkills() {
			if (!this.conn) return;
			try {
				const res = await this.conn.request('skills.status', { agentId: this.agentId });
				this.skillsList = res?.skills ?? res ?? [];
			}
			catch {
				this.skillsList = [];
			}
		},
		async loadTools() {
			if (!this.conn) return;
			try {
				const res = await this.conn.request('tools.catalog', { agentId: this.agentId });
				const catalog = res?.groups ?? res ?? [];
				if (Array.isArray(catalog) && catalog.length && catalog[0]?.tools) {
					this.toolGroups = catalog;
				}
				else if (Array.isArray(catalog)) {
					// 如果返回的是扁平列表，按 group 分组
					const map = {};
					for (const tool of catalog) {
						const g = tool.group ?? 'default';
						if (!map[g]) map[g] = { name: g, tools: [] };
						map[g].tools.push(tool);
					}
					this.toolGroups = Object.values(map);
				}
			}
			catch {
				this.toolGroups = [];
			}
		},
	},
};
</script>
