# :package: Container Builder

[![Latest Release](https://img.shields.io/github/v/release/snapserv/action-container-builder)](https://github.com/snapserv/action-container-builder/releases)
[![License](https://img.shields.io/github/license/snapserv/action-container-builder)](https://github.com/snapserv/action-container-builder/blob/master/LICENSE)

This action will build your container images using Docker in a reliable
and efficient way. Unlike the official
[build-and-push-docker-images](https://github.com/marketplace/actions/build-and-push-docker-images)
action, this action uses a separate image repository for caching single-
or multi-layer builds, greatly speeding up your builds and saving
precious CI resources.

Currently this action only contains a build phase, however it is planned
in the near future to introduce a publish phase which automatically tags
and publishes your image based on references or commit hashes.

For the build phase, you will only need to specify your desired image
repository names along with registry credentials. Container Builder will
automatically detect all stages in your builds and cache them
appropriately by pushing them to another image repository.

## Configuration

### Build Phase

- `target_image`: Specifies the desired repository name for the
  container image which is being built by this action, e.g.
  `my.docker.registry/glados/companion-cube`. While you must specify a
  fully-qualified image repository including the server and namespace,
  you shall **not** specify a tag.

- `target_registry_username`: Specifies the username for authenticating
  against the registry used by `target_image`. Consult the documentation
  of your favorite registry to know what you need to specify, however
  this is equivalent to using `docker login`.

- `target_registry_password`: Specifies the password for authenticating
  against the registry used by `target_image`. Same remarks as for
  `target_registry_username` apply.

- `cache_image`: Overrides the default repository name for the cached
  container build stages. By default, this will be set to `target_image`
  suffixed with `-cache`.

- `cache_registry_username`: Specifies the username for authenticating
  against the registry used by `cache_image`. If not specified, this
  defaults to using the same value as `target_registry_username`.

- `cache_registry_password`: Specifies the password for authenticating
  against the registry used by `cache_image`. If not specified, this
  defaults to using the same value as `target_registry_password`.

- `build_context`: Specifies the path to the Docker build context,
  relative to the repository. This defaults to `.`, which would include
  everything inside your repository. The usage of `.dockerignore`
  applies as usual.

- `build_dockerfile`: Specifies a custom path to the Dockerfile which
  should be built. This defaults to `Dockerfile` and is relative to the
  `build_context`.
