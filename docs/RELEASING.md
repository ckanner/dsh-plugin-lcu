# Releasing

Maintainer notes. This file is not part of the published package.

```sh
node -e "console.log(require('./package.json').version)"   # what would be published
npm publish                                                # prompts for OTP
```

## A successful publish is not immediately visible

The publish flow here is browser-authenticated: the CLI polls `/-/v1/done?authId=…` while the browser confirms,
then `PUT`s the packument and gets **202 Accepted**. npm says so itself:

```
notice Your package is being processed and may take a few minutes to become available.
info ok
```

**202 is success.** The version becomes readable from the registry roughly **five minutes** later — measured at
5m 24s and 5m 38s on this package. Checking two minutes in says "not published" about a publish that worked.

So verify with the registry's own timestamp rather than a version lookup, and give it five minutes before
believing a failure:

```sh
curl -s https://registry.npmjs.org/dsh-plugin-lcu | python3 -c "
import json, sys
d = json.load(sys.stdin)
version = '0.3.5'
print('versions:', sorted(d['versions']))
print('latest  :', d['dist-tags']['latest'])
print(version, 'at:', d.get('time', {}).get(version, 'not published'))
"
```

`npm view <pkg>@<version>` is served through a cache and is not the check to trust here. Neither is
`exit code 0` on its own — it is right, but it cannot tell you the difference between "not yet" and "never".

`.github/workflows/release.yml` guards against re-publishing with `npm view`; during the propagation window that
check can miss a version that is already published, and the workflow then fails on
`cannot publish over the previously published versions`. Treat that error as success.
