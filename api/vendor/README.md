# 共用套件安裝包

此處保存固定版本的 @maderaojen 套件及 SHA-256 manifest，讓本應用程式的 npm ci 不依賴外部 repo 或尚未設定的 npm registry。

實作正本在獨立共用套件 repo，本目錄不接受來源修改。更新時在該 repo 更新版本、建置、測試與打包，再於 Hestia 執行：

```sh
node scripts/import-reusable-packages.mjs <安裝包目錄>
```

接著在 api／web 各自執行 npm install，連同安裝包、manifest、package.json 與 lockfile 一起提交。不要用同一個版本交付不同內容。正式發布到 registry 後，可改用已發布版本依賴，再移除此交付方式。
