Fixes the retry loop in the uploader.

```python
for attempt in range(5):
    try:
        upload()
        break
    except Timeout:
        sleep(2 ** attempt)
```

~~~~yaml
retries: 5
~~~~

````md
```
nested fence
```
````

Logs from before:

```
ERROR upload timed out after 30s
ERROR upload timed out after 30s
```
