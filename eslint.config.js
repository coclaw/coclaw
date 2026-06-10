export default [
	{
		ignores: [
			'**/node_modules/**',
			'**/dist/**',
			'**/dist-ios/**',
			'**/build/**',
			'**/coverage/**',
			'**/.run/**',
			'**/android/**',
			'**/ios/**'
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
			'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
		}
	}
];
