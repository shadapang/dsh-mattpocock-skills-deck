// verify-gitlab-selfhost.ts — 自托管 GitLab 的仓库身份解析（#435）门禁
// 用法: node --import ./scripts/ts-hook.mts tests/verify-gitlab-selfhost.ts
//
// 为什么有它：#435 报的是「自托管 GitLab（IP 形式 remote）认不出仓库；refId 为空时把 cwd 当项目 ID
// 传给 glab，结果 glab 404 Project Not Found」。修复落在 rooms/gitlab/repo.ts 的三层兜底上，
// 但到今天为止一条门禁都没有守着它：谁改坏 parseGitlabRepo，面板只会再退回「未识别仓库」，
// 而且当场没人会发现（自托管环境不在这台机器上，真机复现不了）。
const { parseGitlabRepo, getRepoKey } = require('../src/tracker/rooms/gitlab/repo.ts')

let failed = false
let total = 0
const ok = (cond, msg) => {
  total += 1
  if (cond) console.log('  PASS ' + msg)
  else {
    console.log('  FAIL ' + msg)
    failed = true
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// 一、自托管写法必须认出来（#435 报的就是这一族地址）
const cases = [
  ['git@10.1.2.3:group/project.git', { owner: 'group', name: 'project' }, 'scp 写法 + IP 主机'],
  ['git@10.1.2.3:group/sub/project.git', { owner: 'group/sub', name: 'project' }, '多段分组落成「全部分组/项目名」'],
  ['https://10.1.2.3:8086/group/project.git', { owner: 'group', name: 'project' }, 'http(s) + 自定义端口'],
  ['http://gitlab.internal:8080/group/sub/proj', { owner: 'group/sub', name: 'proj' }, '内网域名 + 端口 + 多段分组'],
  ['ssh://git@gitlab.internal:22/group/project.git', { owner: 'group', name: 'project' }, 'ssh:// 带端口'],
  ['https://gitlab.example.com/group/project.git?ref=main', { owner: 'group', name: 'project' }, '查询串不影响坐标'],
]
for (const [url, want, why] of cases) {
  const got = parseGitlabRepo(url)
  ok(eq(got, want), why + '：' + url + ' → ' + JSON.stringify(got))
}

// 二、认不出的东西必须回 null，绝不编一个坐标。#435 的根因就是「编了一个：把 cwd 当项目 ID」。
for (const bad of ['./some/dir', 'C:\\work\\proj', 'https://gitlab.com/foo', '', null, 42]) {
  ok(parseGitlabRepo(bad) === null, '不编坐标：' + JSON.stringify(bad) + ' → null')
}

// 三、三层兜底的第 1 层：坐标必须来自 remote，绝不能来自 cwd（#435 的 404 根因）
async function tier1() {
  const ctx = {
    platform: { resolveExecutable: async () => 'git' },
    exec: async () => ({ code: 0, stdout: 'git@10.1.2.3:group/project.git', stderr: '' }),
  }
  const cwd = 'D:\\repos\\some-local-dir'
  const key = await getRepoKey(cwd, ctx)
  ok(eq(key, { owner: 'group', name: 'project' }), '第 1 层按 remote 认坐标：' + JSON.stringify(key))
  ok(!!key && key.owner !== 'some-local-dir' && key.name !== 'some-local-dir', '坐标里绝不出现 cwd 目录名（#435 的 404 根因）')
}

// 四、remote 不是可识别地址时回 null，交由下一层兜底，不编 cwd
async function tier1Miss() {
  const ctx = {
    platform: { resolveExecutable: async () => 'git' },
    exec: async () => ({ code: 0, stdout: 'D:\\repos\\some-local-dir', stderr: '' }),
  }
  const key = await getRepoKey('D:\\repos\\some-local-dir', ctx)
  ok(key === null, 'remote 认不出时回 null（不把 cwd 当坐标）：' + JSON.stringify(key))
}

Promise.resolve()
  .then(tier1)
  .then(tier1Miss)
  .then(() => {
    console.log((failed ? 'FAILED' : 'PASSED') + '：' + total + ' 条断言')
    if (failed) process.exitCode = 1
  })
  .catch((e) => {
    console.log('  FAIL 用例自身抛错：' + String((e && e.message) || e))
    console.log('FAILED：' + (total + 1) + ' 条断言')
    process.exitCode = 1
  })
