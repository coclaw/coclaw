export default [
	{
		ignores: [
			'**/node_modules/**',
			'**/dist/**',
			'**/build/**',
			'**/coverage/**',
			'**/.run/**'
		]
	},
	{
		files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module'
		},
		rules: {
			semi: ['error', 'always'],
			indent: ['error', 'tab', { SwitchCase: 1 }],
			'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
		}
	}
];
