import { AuthData, Docker, TaggedImages } from './docker';
import { GitRefType, parseBool, parseGitRef } from './utils';
import * as core from '@actions/core';
import path from 'path';
import { context } from '@actions/github';

type ImageHashes = { [name: string]: string }

class ContainerBuilder {
  private readonly docker: Docker;
  private readonly buildContext: string;
  private readonly buildDockerfile: string;

  private readonly targetImage: string;
  private readonly targetAuth: AuthData;
  private readonly cacheImage: string;
  private readonly cacheAuth: AuthData;

  private readonly staticTags: string[];
  private readonly tagWithRef: boolean;
  private readonly tagWithSHA: boolean;

  constructor() {
    this.docker = new Docker();
    this.buildContext = core.getInput('build_context') || '.';
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

    this.staticTags = core.getInput('tags').split(',').filter(Boolean);
    this.tagWithRef = parseBool(core.getInput('tag_with_ref') || 'false');
    this.tagWithSHA = parseBool(core.getInput('tag_with_sha') || 'false');
  }

  async run() {
    const stageCache = await this.pullCachedStages();
    const newImages = await this.assembleImage(stageCache);
    await this.pushCachedStages(newImages);
    await this.cleanCachedStages(stageCache, newImages);
    const taggedImages = await this.buildTargetImage(newImages);
    await this.publishImages(taggedImages);
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

  private async buildTargetImage(newImages: ImageHashes): Promise<string[]> {
    // Attempt to find output image of final stage
    const finalImageName = `${this.cacheImage}:final`;
    const finalImage = newImages[finalImageName];
    if (!finalImage) throw new Error(`Could not final image build: ${finalImageName}`);

    // Prepare list of desired image tags
    const desiredTags = [...this.staticTags];

    // Add tag with Git commit hash
    if (this.tagWithSHA && context.sha) {
      if (context.sha.length >= 7) {
        desiredTags.push(context.sha.substring(0, 7));
      }
    }

    // Add tag with Git reference
    if (this.tagWithRef && context.ref) {
      const ref = parseGitRef(context.ref);
      switch (ref.type) {
        case GitRefType.Head:
          if (ref.name === 'master') desiredTags.push('latest');
          else desiredTags.push(name);
          break;
        case GitRefType.PullRequest:
          desiredTags.push(`pr-${name}`);
          break;
        case GitRefType.Tag:
          desiredTags.push(name);
          break;
      }
    }

    // Tag final image with all desired tags
    const taggedImages = [];
    for (const tag of desiredTags) {
      core.debug(`Tagging final image as [${this.targetImage}:${tag}]...`);
      taggedImages.push(`${this.targetImage}:${tag}`);
      await this.docker.tagImage(finalImage, this.targetImage, tag);
    }

    return taggedImages;
  }

  private async publishImages(images: string[]): Promise<void> {
    for (const image of images) {
      core.info(`Pushing image [${image}] to registry...`);
      await this.docker.pushImage(image, { auth: this.targetAuth });
    }
  }
}

new ContainerBuilder().run().catch(err => {
  core.error(err);
});
