import Dockerode, { AuthConfig } from 'dockerode';
import * as core from '@actions/core';
import path from 'path';
import glob from 'fast-glob';
import zlib from 'zlib';
import tarFS from 'tar-fs';
import tarStream from 'tar-stream';
import { promises as fs } from 'fs';
import { Readable } from 'stream';
// @ts-ignore

const RE_DOCKER_STAGE = /^\s*FROM\s+[^\s]+\s+AS\s+(?<target>[^\s+]+)$/igm;

export type TaggedImages = { [tag: string]: string }

export type AuthData = {
  username: string;
  password: string;
}

type StreamData = { [key: string]: any };

type ImageSource = {
  repository: string;
  registry: string;
  image: string;
  tag?: string;
}

type PullImageOptions = {
  auth?: AuthData
}

type BuildImageOptions = {
  target?: string,
  cacheFrom?: string[],
}

type PushImageOptions = {
  auth?: AuthData,
  tag?: string,
}

export class Docker {
  private dockerode: Dockerode;
  private placeholderImage?: string;

  constructor() {
    this.dockerode = new Dockerode();
  }

  private static async streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks = [];
    for await(const chunk of stream) {
      chunks.push(chunk);
    }

    return Buffer.concat(chunks);
  }

  async pullImage(name: string, options: PullImageOptions): Promise<void> {
    await this.dockerode.createImage({
      fromImage: name,
      ...(options.auth && { authconfig: this.buildAuthConfig(name, options.auth) }),
    });
  }

  async getImageTags(name: string): Promise<TaggedImages> {
    const images = await this.dockerode.listImages(({
      filters: { reference: [name] },
    }));

    const tags: TaggedImages = {};
    for (const image of images) {
      const isEmpty = image.Labels && image.Labels['net.snapserv.image-type'] == 'empty';
      if (isEmpty) continue;

      for (const tag of image.RepoTags || []) {
        const imageSource = this.parseImageName(tag);
        if (imageSource.tag) tags[imageSource.tag] = image.Id;
      }
    }

    return tags;
  }

  async buildPlaceholderImage(name: string): Promise<string> {
    const dockerfile = [
      'FROM scratch',
      'LABEL net.snapserv.image-type=empty',
    ].join('\n');

    const pack = tarStream.pack();
    const entry = pack.entry({ name: 'Dockerfile', type: 'file', size: dockerfile.length }, err => {
      if (err) pack.destroy(err);
      pack.finalize();
    });
    entry.write(dockerfile);
    entry.end();

    const gzipStream = pack.pipe(zlib.createGzip());
    const gzipBuffer = await Docker.streamToBuffer(gzipStream);
    return this.buildImage(gzipBuffer, name, {});
  }

  async buildImage(archive: Buffer, name: string, options: BuildImageOptions): Promise<string> {
    const stream = await this.dockerode.buildImage(archive as unknown as NodeJS.ReadableStream, {
      t: [name],
      ...(options.cacheFrom && { cachefrom: options.cacheFrom }),
      ...(options.target && { target: options.target }),
    });
    await this.waitForCompletion(stream);

    const image = await this.dockerode.getImage(name).inspect();
    return image.Id;
  }

  async pushImage(name: string, options: PushImageOptions): Promise<void> {
    const image = this.dockerode.getImage(name);
    const stream = await image.push({
      ...(options.auth && { authconfig: this.buildAuthConfig(name, options.auth) }),
      ...(options.tag && { tag: options.tag }),
    });

    await this.waitForCompletion(stream);
  }

  async unpublishImage(name: string, pushOptions: PushImageOptions): Promise<void> {
    const source = this.parseImageName(name);
    switch (source.registry) {
      // Some registries, including GitHub Package Registry, do not support removing packages through UI and/or API. As
      // there is no official Docker API for removing images from a registry, we overwrite the tag with a labeled
      // placeholder image, which saves space and skips this tag in future runs.
      case 'docker.pkg.github.com':
      default:
        core.info(`Uploading empty image to [${name}] as registry does not support deletes...`);
        await this.getPlaceholderImage(name);
        await this.pushImage(name, pushOptions);
        break;
    }
  }

  async tagImage(name: string, repository: string, tag: string): Promise<void> {
    const image = this.dockerode.getImage(name);
    await image.tag({
      repo: repository,
      tag: tag,
    });
  }

  async parseBuildTargets(dockerfile: string): Promise<string[]> {
    const contents = await fs.readFile(dockerfile);

    let match, targets = [];
    while (match = RE_DOCKER_STAGE.exec(contents.toString())) {
      if (match.groups) targets.push(match.groups.target);
    }

    return targets;
  }

  async packBuildContext(context: string): Promise<Buffer> {
    const ignorePatterns = [];

    // Attempt to read and parse .dockerignore file within context directory
    try {
      const contents = await fs.readFile(path.join(context, '.dockerignore'));
      for (let line of contents.toString().split('\n')) {
        if (line.startsWith('#')) continue;
        if (line.length === 0) continue;
        if (line.startsWith('/')) line = line.slice(1);

        ignorePatterns.push(line);
      }
    } catch (e) {
      core.info(`Could not gather .dockerignore from context: ${e}`);
    }

    // Generate list of entries, then create a gzipped tar stream
    const entries = await glob('**', { cwd: context, ignore: ignorePatterns });
    // @ts-ignore
    const tarStream = tarFS.pack(context, { entries, umask: 0 });
    const gzipStream = tarStream.pipe(zlib.createGzip());

    // Return gzip stream as buffer
    return await Docker.streamToBuffer(gzipStream);
  }

  parseImageName(name: string): ImageSource {
    function splitRepositoryTag(value: string): { repository: string, tag?: string } {
      let separatorPos;
      const digestPos = value.indexOf('@');
      const colonPos = value.lastIndexOf(':');

      if (digestPos >= 0) separatorPos = digestPos;
      else if (colonPos >= 0) separatorPos = colonPos;
      else return { repository: value };

      const tag = value.slice(separatorPos + 1);
      if (tag.indexOf('/') === -1) return { repository: value.slice(0, separatorPos), tag };
      else return { repository: value };
    }

    function splitRegistryImage(image: string): { registry: string, image: string } {
      const parts = image.split('/', 2);
      if (parts.length == 1 || (!parts[0].includes('.') && !parts[0].includes(':') && parts[0] != 'localhost')) {
        return { registry: 'docker.io', image: image };
      } else {
        return { registry: parts[0], image: parts[1] };
      }
    }

    const { repository, tag } = splitRepositoryTag(name);
    const { registry, image } = splitRegistryImage(repository);

    return {
      repository,
      registry,
      image,
      tag,
    };
  }

  private async getPlaceholderImage(name: string): Promise<void> {
    if (!this.placeholderImage) {
      core.info(`Building placeholder image for [${name}]...`);
      this.placeholderImage = await this.buildPlaceholderImage(name);
    } else {
      core.info(`Reusing placeholder image for [${name}]...`);
    }

    const source = this.parseImageName(name);
    await this.tagImage(this.placeholderImage, source.repository, source.tag || 'latest');
  }

  private async waitForCompletion(stream: NodeJS.ReadableStream): Promise<StreamData[]> {
    return new Promise((resolve, reject) => {
      let previousLine: string = '';

      this.dockerode.modem.followProgress(stream, (err: Error, res: StreamData[]) => {
        if (err) return reject(err);

        const streamErr = res.find(x => x['error']);
        if (streamErr) return reject(streamErr['error']);

        return resolve(res);
      }, (data: StreamData) => {
        if (!data.stream) return;

        const output = previousLine + data.stream.toString();
        const lines = output.replace(/(\r\n|\r|\n)+/gm, '\n').split('\n');
        previousLine = lines.pop() || '';

        lines
          .map(line => line.trim()) // Trim each line
          .filter(Boolean) // Remove empty lines from output
          .map((line: string) => core.info(`stream output: ${line}`)); // Output each line
      });
    });
  }

  private buildAuthConfig(imageName: string, data: AuthData): AuthConfig {
    const imageSource = this.parseImageName(imageName);

    return {
      username: data.username,
      password: data.password,
      serveraddress: imageSource.registry,
    };
  }
}
