<template>
	<main class="flex-1 overflow-auto md:px-8 md:pt-6">
		<div class="mx-auto flex min-h-0 w-full max-w-3xl flex-1">
			<MainList :current-path="$route.path" />
		</div>
	</main>
</template>

<script>
import MainList from '../components/MainList.vue';

export default {
	name: 'TopicsPage',
	components: {
		MainList,
	},
};
</script>
