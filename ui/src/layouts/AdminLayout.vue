<template>
	<router-view />
</template>

<script>
import { useAdminStore } from '../stores/admin.store.js';

// Admin 区薄壳父路由：挂载时启动 SSE 订阅，卸载时停止。
// 三个 admin 子页（dashboard / claws / users）切换时 AdminLayout 不重挂，
// 离开 /admin/* 才会 beforeUnmount → 自动断连，形成清晰的权限边界。
export default {
	name: 'AdminLayout',
	setup() {
		return { adminStore: useAdminStore() };
	},
	mounted() {
		this.adminStore.startStream();
	},
	beforeUnmount() {
		this.adminStore.stopStream();
	},
};
</script>
