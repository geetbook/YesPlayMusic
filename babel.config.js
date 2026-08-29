module.exports = {
  presets: [
    [
      '@vue/cli-plugin-babel/preset',
      {
        useBuiltIns: 'usage',
        shippedProposals: true,
        // 显式压低目标，强制 @babel/preset-env 把 ?. / ?? 等 proposal-level 语法转成
        // ES5 等价写法。Tesla 车机 WebKit 远低于 Chrome 80（原生支持 ?. 的最低版本），
        // 老 browserslist "last 2 versions" 根本覆盖不到这种小众长尾，
        // 结果 src 里 55+ 处 ?. / ?? 被原样打进 chunk → 老 WebKit SyntaxError →
        // 整段 chunk load 失败 → 白屏点播放没反应。chrome 60 ≈ 2017 年的 WebKit/Chromium
        // 基线，Tesla / 国产老车机 WebView 都在这个水平线以上能跑。
        targets: {
          chrome: '60',
          safari: '12',
          ios: '12',
          edge: '18',
          firefox: '68',
          android: '67',
        },
      },
    ],
  ],
  // 注意：这里不用显式 plugins 数组，preset-env 内部就带 optional-chaining /
  // nullish-coalescing-operator 的实现，只看 targets 决定开不开。
  // 显式加 require.resolve('@babel/plugin-proposal-optional-chaining') 反而
  // 要多装 devDep 导致 package-lock.json mismatch 让 Vercel build fail。
};
