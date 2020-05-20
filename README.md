# :package: Container Builder

[![Latest Release](https://img.shields.io/github/v/release/snapserv/action-container-builder)](https://github.com/snapserv/action-container-builder/releases)
[![License](https://img.shields.io/github/license/snapserv/action-container-builder)](https://github.com/snapserv/action-container-builder/blob/master/LICENSE)

This action will build and publish your container images using Docker in
a reliable and efficient way. Unlike the official
[build-and-push-docker-images](https://github.com/marketplace/actions/build-and-push-docker-images)
action, this action uses a separate image repository for caching single-
or multi-layer builds, greatly speeding up your builds and saving
precious CI resources.

Currently this action contains two stages. The build phase builds your
image using cached layers on a registry, whereas the publish phase
pushes the built image with all desired tags to the registry.

For the build phase, you will only need to specify your desired image
repository names along with registry credentials. Container Builder will
automatically detect all stages in your builds and cache them
appropriately by pushing them to another image repository.

For the publish phase, you will need to either specify `tags`,
`tag_with_ref` or `tag_with_sha` as otherwise no image (except from the
previously built cache layers) are being pushed to your registry.

## Usage

The following snippet is an example GitHub workflow (e.g.
`.github/workflows/main.yml`) which automatically builds a `Dockerfile`
in the repository root, caching all stages on GitHub Package Registry
while having the final images on the official Docker Registry:

```yaml
name: Container Builder

on:
  - push
  - pull_request

jobs:
  container-builder:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v2

      - name: Build container image
        uses: snapserv/action-container-builder@master
        with:
          target_repository: my-user/my-image
          target_registry_username: {{ secrets.DOCKER_REGISTRY_USERNAME }}
          target_registry_password: {{ secrets.DOCKER_REGISTRY_PASSWORD }}
          cache_repository: docker.pkg.github.com/${{ github.repo }}/my-image
          cache_registry_username: ${{ github.repository_owner }}
          cache_registry_password: ${{ secrets.GITHUB_TOKEN }}
```

Please make sure to use `actions/checkout` before this action, as
otherwise Container Builder will be unable to build your image.

## Configuration

### Build Phase

- `build`: Boolean, can be set to `true` or `false`, defaults to `true`.
  Specifies if the build phase should be executed or skipped.

- `target_repository`: Specifies the desired repository name for the
  container image which is being built by this action, e.g.
  `my-user/my-image` or `my.docker.registry/my-user/my-image`. While you
  must specify a fully-qualified image repository including the server
  and namespace, you shall **not** specify a tag.

- `target_registry_username`: Specifies the username for authenticating
  against the registry used by `target_repository`. Consult the
  documentation of your favorite registry to know what you need to
  specify, however this is equivalent to using `docker login`.

- `target_registry_password`: Specifies the password for authenticating
  against the registry used by `target_repository`. Same remarks as for
  `target_registry_username` apply.

- `cache_repository`: Overrides the default repository name for the
  cached container build stages. By default, this will be set to
  `target_repository` suffixed with `-cache`.

- `cache_registry_username`: Specifies the username for authenticating
  against the registry used by `cache_repository`. If not specified,
  this defaults to using the same value as `target_registry_username`.

- `cache_registry_password`: Specifies the password for authenticating
  against the registry used by `cache_repository`. If not specified,
  this defaults to using the same value as `target_registry_password`.

- `build_context`: Specifies the path to the Docker build context,
  relative to the repository. This defaults to `.`, which would include
  everything inside your repository. The usage of `.dockerignore`
  applies as usual.

- `build_dockerfile`: Specifies a custom path to the Dockerfile which
  should be built. This defaults to `Dockerfile` and is relative to the
  `build_context`.

### Publish Phase

- `publish`: Boolean, can be set to `true` or `false`, defaults to
  `true`. Specifies if the publish phase should be executed or skipped.

- `tags`: Comma-separated list of tags which should always be added when
  publishing the image to your target registry.

- `tag_with_ref`: Automatically tags your image based on the current Git
  reference. All branch pushes and Git tags are being taken as-is when
  tagging the image with the exception of a branch called `master`,
  which gets automatically translated to `latest`. Pull requests are
  being tagged as `pr-{number}`.

- `tag_with_sha`: Automatically tags your image based on the short Git
  commit SHA, prefixed with `sha-`.

