# 展示资源目录

README 展示图片统一放这里（`assets/screenshots/`）。

## 为什么放这里（与开发文档分离）

- 本仓库刻意分层：`README.md` + `assets/` 是**使用者文档**（随 npm 包发布，
  `package.json` 的 `files` 含 `assets`）；`docs/` 是**开发文档**（仅仓库内
  给贡献者，**不随包发布**）。展示图片属于使用者文档，因此必须放在
  `assets/` 而不是 `docs/`，否则会被一并排除。
- npm registry 与 GitHub 都支持 README 相对路径图片，一处存放、两处生效。

## 命名建议

- 语义化、kebab-case：如 `live-panel.webp`、`settings-card.webp`、
  `chat-turn-tail.webp`、`summary-view.webp`；
- 截图建议用 **WebP**（质量 80–85，缩放至 ≤1600px 宽），单张 < 150KB，
  README 首屏不拖慢。转换示例（ffmpeg）：

```powershell
ffmpeg -i 原图.png -vf "scale=1600:-1:flags=lanczos" -c:v libwebp -quality 82 -compression_level 6 输出.webp
```

## 在 README 中引用

```markdown
![实时面板](assets/screenshots/live-panel.webp)
```

> 相对路径以**仓库根**为基准（`assets/screenshots/`），不带前导 `./` 更稳。
