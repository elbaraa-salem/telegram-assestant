# Receipt Cleanup

Recommended cron:

```cron
0 4 * * 0 cd /home/albaraa/applications/telegram-assestant && npm run cleanup:receipts:prod >> logs/receipt-cleanup.log 2>&1
```
