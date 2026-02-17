# 🚀 GHOST-HANDS Quick Start Guide

## 使用 Applicant Profile 自动投递 Workday

### Step 1: 设置环境

```bash
cd /Users/shluo03/Desktop/wecrew/GHOST-HANDS/magnitude-source

# 设置 API Key (选择其一)
export SILICONFLOW_API_KEY=your_siliconflow_key  # 推荐：便宜
export ANTHROPIC_API_KEY=your_anthropic_key      # 或者用 Claude
```

### Step 2: 准备简历文档

```bash
# 确保简历文件存在（可选，如果不需要上传可以跳过）
# ./resumes/joy-kim-resume.pdf
```

### Step 3: 运行自动投递

```bash
# 方法 1: 使用 npm script
bun run workday-profile "https://your-workday-job-url.com"

# 方法 2: 直接运行
bun run workday-with-profile.ts "https://your-workday-job-url.com"
```

### Step 4: 监控执行过程

脚本会自动：
1. ✅ 加载 Joy Kim 的 profile
2. ✅ 启动浏览器（Chrome）
3. ✅ 导航到职位页面
4. ✅ 分析表单字段
5. ✅ 自动填写信息
6. ✅ 上传简历（如果需要）
7. ⏸️ 暂停等待确认
8. ✅ 提交申请

## 📋 Profile 文件说明

### Joy Kim Profile 已包含：

```json
{
  "personal": {
    "name": "Joy Kim",
    "email": "shuizhuolana@gmail.com",
    "phone": "(310) 849-4938",
    "location": "Los Angeles, CA"
  },
  "education": {
    "school": "USC",
    "degree": "B.S. Computer Science",
    "gpa": "3.82"
  },
  "experience": [
    {
      "company": "Stripe",
      "title": "Software Engineer II",
      "current": true
    }
  ],
  "skills": {
    "languages": ["Python", "Go", "JavaScript", ...],
    "frameworks": ["React", "Node.js", "Kafka", ...]
  }
}
```

## 🎯 支持的表单字段

自动识别并填写：

| 类别 | 字段示例 |
|------|---------|
| **个人信息** | First Name, Last Name, Email, Phone |
| **地址** | City, State, Zip Code, Country |
| **教育** | School, Degree, Major, GPA, Graduation Date |
| **工作经历** | Current Company, Current Title, Years of Experience |
| **链接** | LinkedIn, GitHub, Portfolio |
| **工作偏好** | Work Authorization, Sponsorship, Start Date |

## 💡 常见问题处理

### Q1: Agent 卡在登录页面？

**原因**: 很多 ATS 需要先登录才能申请

**解决方案 1**: 手动登录后运行脚本
```bash
# 1. 先在浏览器中登录 Workday/Seek/等
# 2. 保持浏览器打开
# 3. 运行脚本会复用现有 session
```

**解决方案 2**: 使用 Cookie 注入
```typescript
// 在 workday-with-profile.ts 中添加
await context.addCookies([
  {
    name: 'auth_token',
    value: 'your_token',
    domain: '.workday.com',
    path: '/'
  }
]);
```

### Q2: 某些字段没有填写？

**原因**: LLM 可能没有识别到字段或字段名称不匹配

**解决方案**: 更新 `generateFieldMappings()` 函数
```typescript
// 在 workday-with-profile.ts 中添加新的字段映射
"Your Custom Field": profile.custom.field,
```

### Q3: 想修改 profile 信息？

**直接编辑**:
```bash
# 打开 profile 文件
code /Users/shluo03/Desktop/wecrew/GHOST-HANDS/applicant-profiles/joy-kim.json

# 修改后保存，立即生效
```

### Q4: 创建新的 profile？

```bash
# 复制模板
cp applicant-profiles/joy-kim.json applicant-profiles/john-doe.json

# 编辑新文件
code applicant-profiles/john-doe.json

# 在脚本中更改 profile 名称
# const profile = loadProfile("john-doe");
```

## 🔧 高级配置

### 使用不同的 LLM

```bash
# 使用 Qwen (便宜)
export SILICONFLOW_API_KEY=xxx
bun run workday-profile <url>

# 使用 Claude (准确)
export ANTHROPIC_API_KEY=xxx
bun run workday-profile <url>

# 使用 DeepSeek (最便宜)
export DEEPSEEK_API_KEY=xxx
# 需要修改脚本添加 DeepSeek 支持
```

### 调试模式

```typescript
// 在 workday-with-profile.ts 中
const agent = await startBrowserAgent({
  browser: { context },
  llm: llmConfig,
  url: jobUrl,
  narrate: true,        // ← 显示 agent 思考过程
  verbose: true,        // ← 更详细的日志
});
```

### 无头模式（后台运行）

```typescript
const context = await chromium.launchPersistentContext("", {
  channel: "chrome",
  headless: true,  // ← 改为 true
  viewport: { width: 1280, height: 1024 },
});
```

## 📊 成本预估

| LLM | 单次申请成本 | 100次成本 |
|-----|-------------|-----------|
| **Qwen VL 7B** | ~$0.002 | ~$0.20 |
| **Claude Sonnet** | ~$0.08 | ~$8.00 |
| **DeepSeek** | ~$0.003 | ~$0.30 |

**推荐**: 使用 Qwen VL 72B（准确度高且便宜）

## 📸 截图示例

脚本运行时你会看到：

```
🎯 GhostHands Workday Application with Profile
============================================================

📋 Loading applicant profile...
✅ Loaded profile: Joy Kim - Software Engineer

🚀 Launching browser...
🤖 Using LLM: Qwen/Qwen2.5-VL-72B-Instruct

📍 Navigating to: https://...

============================================================
Starting application process...
============================================================

[1/4] Analyzing the application form...
[agent] Looking at page structure...
[agent] Found application form with 15 fields

[2/4] Filling personal information...
[agent] Filling first name: Joy
[agent] Filling last name: Kim
[agent] Filling email: shuizhuolana@gmail.com
...

[3/4] Checking for resume upload...
📎 Resume upload detected - handling file picker...
✅ Resume uploaded

[4/4] Reviewing application...
[agent] All required fields filled
[agent] Ready for submission

============================================================
✅ Application form filled successfully!
============================================================

⏸️  Pausing for manual review...
   Review the form in the browser window.
   Press Enter to continue and submit, or Ctrl+C to cancel.
```

## 🎓 下一步

1. **测试基础功能**: 先在简单的表单上测试
2. **调整 Profile**: 根据实际需求修改字段
3. **添加 Manual 系统**: 配合自学习手册系统使用
4. **批量投递**: 创建循环脚本处理多个职位

## 📚 相关文档

- [Profile 详细说明](./applicant-profiles/README.md)
- [项目总览](./GHOSTHANDS-README.md)
- [测试计划](./TEST-PLAN.md)

## 💬 获取帮助

遇到问题？
1. 检查终端错误信息
2. 查看浏览器窗口中的实际操作
3. 调整 LLM 的 narrate 参数查看思考过程
4. 尝试不同的 LLM 模型

