module.exports = {
  presets: [
    [
      '@vue/cli-plugin-babel/preset',
      {
        useBuiltIns: 'usage',
        shippedProposals: true,
      },
    ],
  ],
  plugins: [
    // 兼容 Tesla 老 WebKit / 旧 Chromium：统一把 src 里所有 ?. / ?? 转成 ES5 等价写法，
    // 避免打包后 SyntaxError 导致整段 chunk load 失败白屏（Tesla 车机 WebKit 远低于
    // Chrome 80，即使 browserslist "last 2 versions" 也覆盖不到它）
    require.resolve('@babel/plugin-proposal-optional-chaining'),
    require.resolve('@babel/plugin-proposal-nullish-coalescing-operator'),
  ],
};
