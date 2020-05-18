import { AuthData, Docker, TaggedImages } from './docker';
import * as core from '@actions/core';
import path from 'path';

type ImageHashes = { [name: string]: string }

class ContainerBuilder {
  private readonly docker: Docker;
  private readonly buildContext: string;
  private readonly buildDockerfile: string;

  private readonly targetImage: string;
  private readonly targetAuth: AuthData;
  private readonly cacheImage: string;
  private readonly cacheAuth: AuthData;

  constructor() {
    this.docker = new Docker();
    this.buildContext = core.getInput('build_context', { required: true });
    this.buildDockerfile = path.join(this.buildContext, core.getInput('build_dockerfile') || 'Dockerfile');

    this.targetImage = core.getInput('target_image', { required: true });
    this.targetAuth = {
      username: core.getInput('target_registry_username', { required: true }),
      password: core.getInput('target_registry_password', { required: true }),
    };

    this.cacheImage = core.getInput('cache_image') || `${this.targetImage}-cache`;
    this.cacheAuth = {
      username: core.getInput('cache_registry_username') || this.targetAuth.username,
      password: core.getInput('cache_registry_password') || this.targetAuth.password,
    };
  }

  async run() {
    const stageCache = await this.pullCachedStages();
    const newImages = await this.assembleImage(stageCache);
    await this.pushCachedStages(newImages);
    await this.cleanCachedStages(stageCache, newImages);
  }

  private async pullCachedStages(): Promise<TaggedImages> {
    try {
      core.debug(`Attempting to pull all image versions of [${this.cacheImage}]...`);
      await this.docker.pullImage(this.cacheImage, { auth: this.cacheAuth });

      core.debug(`Analyzing retrieved cache images of [${this.cacheImage}]...`);
      const stageCache = await this.docker.getImageTags(this.cacheImage);
      const tags = Object.keys(stageCache);
      core.debug(`Found ${tags.length} previous cache images: ${tags.join(', ')}`);

      return stageCache;
    } catch (e) {
      core.debug(`Could not retrieve cached stages, continuing without cache: ${e}`);
      return {};
    }
  }

  private async assembleImage(stageCache: TaggedImages): Promise<ImageHashes> {
    // Generate tarball of build context
    const archive = await this.docker.packBuildContext(this.buildContext);

    // Prepare for building the Dockerfile
    const newImages: ImageHashes = {};
    const cacheFrom = Object.values(stageCache);

    // Determine multi-stage targets and build each one separately
    const targets = await this.docker.parseBuildTargets(this.buildDockerfile);
    for (const target of targets) {
      // Build image for the given target
      const imageName = `${this.cacheImage}:stage-${target}`;
      const imageID = await this.docker.buildImage(archive, imageName, { cacheFrom, target });

      // Keep reference to built target image and add it to the cache
      newImages[imageName] = imageID;
      cacheFrom.push(imageID);
      core.debug(`Built multi-stage target [${target}] as [${imageID}]`);
    }

    // Build the final stage of the Dockerfile
    const imageName = `${this.cacheImage}:final`;
    const imageID = await this.docker.buildImage(archive, imageName, { cacheFrom });

    // Keep reference to built image
    newImages[imageName] = imageID;
    core.debug(`Built final stage [${imageName}] as [${imageID}]`);

    return newImages;
  }

  private async pushCachedStages(newImages: ImageHashes): Promise<void> {
    for (const [imageName, imageID] of Object.entries(newImages)) {
      core.debug(`Pushing cached stage [${imageName}] (${imageID})...`);
      await this.docker.pushImage(imageName, { auth: this.cacheAuth });
    }
  }

  private async cleanCachedStages(stageCache: TaggedImages, newImages: ImageHashes): Promise<void> {
    const currentTags = Object.keys(stageCache);
    const expectedTags = Object.keys(newImages).map(x => this.docker.parseImageName(x).tag).filter(Boolean);

    for (const tag of currentTags) {
      if (expectedTags.indexOf(tag) === -1) {
        core.info(`Found outdated cache image: ${this.cacheImage}:${tag}`);
        await this.docker.unpublishImage(`${this.cacheImage}:${tag}`, { auth: this.cacheAuth });
      }
    }
  }
}

new ContainerBuilder().run().catch(err => {
  core.error(err);
});
