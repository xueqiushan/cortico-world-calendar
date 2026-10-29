# 发布指南（从零到别人能装）

发到 npm 之后，Coopanion 的「扩展」页会列出 npm 上带 `cortico-world` 关键字的包，
所以只要发上去，别人就能在扩展市场里搜到并安装。**不需要先申请进官方索引。**

---

## 先说一个结论：GitHub 不是必需的

`npm publish` **不要求**你有 GitHub 仓库。

`package.json` 里的 `repository` / `homepage` / `bugs` 三个字段，作用只是：
在 npm 页面上显示源码链接，给别人一个提 issue 的地方。

- 有仓库 → 别人踩坑能提 issue，你不用被私信轰炸
- 没仓库 → 把这三个字段**整个删掉**，功能一点不受影响

**但绝不能留着 `CHANGE_ME`** —— 那会让 npm 页面上出现指向不存在的链接，比没有更难看。

---

## 一、GitHub 用户名

### 你现在叫什么？

右上角点头像 → **Settings** → 左边栏 **Account** → 页面里就能看到当前用户名。
（或者直接看浏览器地址栏 `github.com/这里就是你的用户名`）

### 要不要改名？

**为了发这个插件，没必要改。** 你只需要知道自己现在叫什么，填进 package.json 就行。

### 如果确实想改

```
右上角头像 → Settings → Account（左边栏）
→ "Change username" 区块 → Change username
→ 读警告 → I understand, let's change my username
→ 输入新名字 → Change my username
```

⚠️ **改名的真实代价**（官方说明）：

| 影响 | 说明 |
|---|---|
| 旧用户名会被释放 | **别人可以立刻抢注** |
| 仓库链接 | 会自动重定向，几分钟生效 ✅ |
| 个人主页旧链接 | **直接 404，不重定向** ❌ |
| @提及、旧 gist 链接 | 不重定向 ❌ |
| 提交归属 | 用 noreply 邮箱的 commit 可能不再归到你名下 |

所以：**已有仓库或对外链接的话，别轻易改。** 新号随便改。

---

## 二、建仓库（10 分钟）

### 网页操作

```
1. github.com 右上角 + → New repository
2. Owner：选你自己
3. Repository name：cortico-world-calendar
4. Public（公开）
5. ⚠️ 底下三个都别勾：
     □ Add a README file
     □ Add .gitignore
     □ Choose a license
   —— 因为本地已经有了，勾了会冲突
6. Create repository
```

建完会跳到 Quick Setup 页，**别关**，下面要用它的命令。

### 把本地代码推上去

在 PowerShell 里（用户名已填好）：

```powershell
cd D:\NPM\cortico-world-calendar

git init
git add .
git commit -m "feat: 共享日历 World 插件 v0.1.0"

git branch -M main
git remote add origin https://github.com/xueqiushan/cortico-world-calendar.git
git push -u origin main
```

⚠️ **推之前确认一件事**：

```
web\calendar.json
```

这个是你自己的日程数据（可能有私人的事、感受）。
**不想公开就先加进 `.gitignore`**，或者推之前删掉内容只留空壳：

```json
{ "version": 0, "events": [] }
```

（服务启动时会自动重建空的，不影响使用。）

### 没装 git？

`winget install Git.Git`，装完重开 PowerShell。

---

## 三、填 package.json

已填好（`xueqiushan`）：

```json
"author": { "name": "xue" },
"repository": {
  "type": "git",
  "url": "git+https://github.com/xueqiushan/cortico-world-calendar.git"
},
"homepage": "https://github.com/xueqiushan/cortico-world-calendar#readme",
"bugs": {
  "url": "https://github.com/xueqiushan/cortico-world-calendar/issues"
}
```

> `git+https://` 这个前缀是 npm 要求的固定写法，照抄即可，不是笔误。

**不建仓库的话**，把 `repository` / `homepage` / `bugs` 三块整个删掉。

---

## 四、发布到 npm

### 1. 注册账号

npmjs.com → Sign up。**现在需要开 2FA**（双因素验证），按提示用验证器 App 绑定，
**恢复码一定要存好**。

### 2. 先查名字有没有被占

```powershell
npm view cortico-world-calendar
```

- 报 `404` → 名字是空的，可以用 ✅
- 显示别人的包 → **这个名字不能用了**，改个名：

```json
"name": "cortico-world-calendar-xue"
```

（改包名不影响任何功能。）

### 3. 登录

```powershell
npm login
```

会打开网页让你授权，按提示走完。

### 4. 看看会上传什么（重要）

```powershell
npm pack --dry-run
```

检查清单里**不能出现 `web\calendar.json`** —— 那是你的私人日程数据。

这一版 `package.json` 的 `files` 用的是**显式列举**写法（而不是笼统的 `"web"`），
就是为了把它挡在外面。实测过，有效。

⚠️ **以后往 `web\` 里加新文件时，记得同步更新 `files`** ——
否则新文件不会进包，装的人会缺东西。

> 附带说明：`.npmignore` 里也排除了它，但实测 npm 在 `files` 白名单存在时
> 并不可靠地应用 `.npmignore`，所以**真正起作用的是 `files` 显式列举**。

### 5. 发布

```powershell
npm publish --registry=https://registry.npmjs.org/
```

加 `--registry` 是因为本机默认源可能是淘宝镜像，不加会失败。

成功会显示：

```
+ cortico-world-calendar@0.1.0
```

---

## 五、验证

1. 打开 `https://www.npmjs.com/package/cortico-world-calendar` → 能看到说明页
2. Coopanion → 扩展 → 搜 `calendar` → 应该能搜到
3. 让别人装一次：

```powershell
cd D:\Coopanion\data\extensions
corepack pnpm add --ignore-workspace cortico-world-calendar
```

重启 Coopanion，World 总览里启用。

---

## 六、以后更新

npm **不允许覆盖同名同版本**。每次改完先升版本号：

```powershell
npm version patch    # 0.1.0 → 0.1.1（修 bug）
npm version minor    # 0.1.0 → 0.2.0（加功能）
npm publish --registry=https://registry.npmjs.org/
```

---

## 七、发布前的诚实自查

这个插件**只在我这边做过自动化验证**，没在别人的机器上跑过。所以 README 里
建议写一句：

> 已验证环境：Windows 11 + Node v24 + Edge + Coopanion x.x.x
> 其他环境待验证。

另外两个已知边界，写进 README 能省掉别人来问：

| 边界 | 说明 |
|---|---|
| **C 形态没做** | 现在是普通窗口（A），真桌面挂件（C）是后续的事 |
| **提醒依赖 Coopanion** | Coopanion 关着时她不提醒，靠网页的浏览器通知兜底 |

---

## 八、可选：进官方索引

官方索引仓库：**`Pal-AI-Lab/cortico-extensions`**

进了索引，市场里会额外显示**标签、徽章、投票、评论**。不进也能搜到能装，
只是没这些。

做法：去那个仓库提 PR，按它的 README 格式把包加进去。
