/** Tailwind 配置：只扫 web/ 下的 html 与 js，产出给 manage.mjs 直接用 */
module.exports = {
  content: ['./web/index.html', './web/app.js'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
      },
    },
  },
  plugins: [require('flowbite/plugin')],
};
